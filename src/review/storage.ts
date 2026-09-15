import type { ReviewState } from "./types";
import { ReviewError } from "./types";

/** 版本化持久化。浏览器用 localStorage，Node 验证时可注入内存实现 */
export interface KV {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  /** 枚举所有键（用于接管已关闭标签遗留的 outbox）；localStorage 适配器需提供 */
  keys?(): string[];
}

export const SERVER_KEY = "rx-review/server-state/v1";
export const CLIENT_KEY = "rx-review/client-snapshot/v1";
export const SETTINGS_KEY = "rx-review/settings/v1";
export const LOCK_KEY = "rx-review/server-lock/v1";

export interface ClientSnapshot {
  version?: number;
  state: ReviewState;
  outbox: { action: import("./types").ReviewAction; opKey: string }[];
  recent: Record<string, { actionId: string; at: string }>;
  updatedAt: string;
}

/** 每个标签页自己的持久数据（outbox 按标签分键，互不覆盖，崩溃后可被接管） */
export interface LocalClientData {
  clientId: string;
  state: ReviewState; // 乐观视图（含待同步标记），仅供本标签刷新后即时恢复
  outbox: { action: import("./types").ReviewAction; opKey: string }[];
  recent: Record<string, { actionId: string; at: string }>;
  heartbeat: number; // 最后写入时间（ms）；超过阈值视为标签已关闭
  updatedAt: string;
}

export function localKey(clientId: string): string {
  return `rx-review/client/v2#${clientId}`;
}

const CLIENT_STALE_MS = 8_000;

function migrateState(parsed: ReviewState): ReviewState {
  const state: ReviewState = {
    version: 2,
    rev: typeof parsed.rev === "number" ? parsed.rev : 0,
    items: Array.isArray(parsed.items) ? parsed.items : [],
    processedActions: parsed.processedActions ?? {},
  };
  for (const key of Object.keys(state.processedActions)) {
    const v = state.processedActions[key];
    if (v !== key) state.processedActions[key] = key; // 旧值是审计 id，归一
  }
  return state;
}

function migrateView(parsed: unknown): ReviewState | null {
  if (!parsed || typeof parsed !== "object") return null;
  const s = parsed as ReviewState;
  if (!Array.isArray(s.items)) return null;
  return s.version === 2 && typeof s.rev === "number" ? s : migrateState(s);
}

export function loadState(kv: KV, key: string = SERVER_KEY): ReviewState | null {
  const raw = kv.getItem(key);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as ReviewState;
    return migrateView(parsed);
  } catch {
    return null;
  }
}

export function saveState(kv: KV, key: string, state: ReviewState): void {
  kv.setItem(key, JSON.stringify(state));
}

export function loadJSON<T>(kv: KV, key: string): T | null {
  const raw = kv.getItem(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function saveJSON(kv: KV, key: string, value: unknown): void {
  kv.setItem(key, JSON.stringify(value));
}

/**
 * 读取本标签的本地数据（v2 分键）。state 经同样的迁移逻辑升级。
 */
export function loadLocalData(kv: KV, clientId: string): LocalClientData | null {
  const data = loadJSON<LocalClientData>(kv, localKey(clientId));
  if (!data) return null;
  const state = migrateView(data.state);
  if (!state) return null;
  return {
    clientId,
    state,
    outbox: Array.isArray(data.outbox) ? data.outbox : [],
    recent: data.recent ?? {},
    heartbeat: typeof data.heartbeat === "number" ? data.heartbeat : 0,
    updatedAt: data.updatedAt ?? "",
  };
}

export function saveLocalData(kv: KV, data: LocalClientData): void {
  saveJSON(kv, localKey(data.clientId), data);
}

/** v1/v2 早期共用快照（CLIENT_KEY）读取：一次性迁移用，取走后由调用方删除 */
export function loadLegacySnapshot(kv: KV): ClientSnapshot | null {
  const snap = loadJSON<ClientSnapshot>(kv, CLIENT_KEY);
  if (!snap || !snap.state) return null;
  const state = migrateView(snap.state);
  if (!state) return null;
  return {
    version: snap.version ?? 1,
    state,
    outbox: Array.isArray(snap.outbox) ? snap.outbox : [],
    recent: snap.recent ?? {},
    updatedAt: snap.updatedAt ?? "",
  };
}

/** 列出所有在本域写过本地数据的标签 id */
export function listLocalClientIds(kv: KV): string[] {
  const prefix = "rx-review/client/v2#";
  return (kv.keys?.() ?? [])
    .filter((k) => k.startsWith(prefix))
    .map((k) => k.slice(prefix.length));
}

/**
 * 扫描已关闭/失活标签遗留的 outbox（心跳超过 staleMs）。
 * excludeSelf 不返回自己的 id。调用方接管后应删除对应键。
 */
export function scanStaleOutboxes(
  kv: KV,
  selfId: string,
  nowMs: number,
  staleMs: number = CLIENT_STALE_MS
): { clientId: string; outbox: LocalClientData["outbox"] }[] {
  const out: { clientId: string; outbox: LocalClientData["outbox"] }[] = [];
  for (const id of listLocalClientIds(kv)) {
    if (id === selfId) continue;
    const data = loadJSON<LocalClientData>(kv, localKey(id));
    if (!data) continue;
    if (nowMs - (data.heartbeat ?? 0) > staleMs && Array.isArray(data.outbox) && data.outbox.length > 0) {
      out.push({ clientId: id, outbox: data.outbox });
    }
  }
  return out;
}

const DEFAULT_LOCK_TTL_MS = 4_000;
const DEFAULT_LOCK_WAIT_MS = 2_000;
const DEFAULT_LOCK_RETRY_MS = 60;
/**
 * 写入锁后等待"竞态窗口"再回读：两个等待者即便都读到空锁并先后写入，
 * 后写者会覆盖先写者；等待后只有值仍为自己的一方进入临界区（last-writer-wins）。
 * localStorage 的每次 setItem 在同一事件循环 tick 内顺序生效，20ms 足以让同刻
 * 发起的写入全部落定。
 */
const LOCK_SETTLE_MS = 20;

interface LockPayload {
  owner: string;
  at: number;
}

export interface LockOptions {
  ttlMs?: number; // 持锁进程/标签崩溃后，锁最多存活这么久
  waitMs?: number; // 等待他人释放的最长时间
  retryMs?: number;
  settleMs?: number;
  now?: () => number;
}

function isFree(raw: string | null, self: string, now: number, ttlMs: number): boolean {
  if (!raw) return true;
  try {
    const lock = JSON.parse(raw) as LockPayload;
    return lock.owner === self || now - lock.at > ttlMs;
  } catch {
    return true; // 锁内容损坏：视为可接管
  }
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 跨标签互斥（同一 KV/localStorage）。
 *
 * localStorage 没有原子 CAS，采用"写后等待确认（最后写入者获胜）"：
 *   1) 读到空闲（无锁 / 自己的锁 / 已过 TTL）才尝试写入自己的 token；
 *   2) 写入后等待 settleMs，回读仍为自己 → 唯一获胜者进入临界区；
 *   3) 回读是他人 → 本轮落败，退避后重试（不会双进临界区）。
 *
 * - 临界区只包裹同步的"读-改-写"，正常持锁时间极短
 * - TTL：持锁标签崩溃/关闭没释放时，不永久阻塞其它提交，TTL 后可被接管
 * - waitMs 内抢不到 → 抛 LOCK_BUSY，调用方把动作留在 outbox 退避重试
 */
export async function withServerLock<T>(
  kv: KV,
  owner: string,
  fn: () => T | Promise<T>,
  opts: LockOptions = {}
): Promise<T> {
  const ttlMs = opts.ttlMs ?? DEFAULT_LOCK_TTL_MS;
  const waitMs = opts.waitMs ?? DEFAULT_LOCK_WAIT_MS;
  const retryMs = opts.retryMs ?? DEFAULT_LOCK_RETRY_MS;
  const settleMs = opts.settleMs ?? LOCK_SETTLE_MS;
  const now = opts.now ?? Date.now;

  const deadline = now() + waitMs;
  for (;;) {
    if (isFree(kv.getItem(LOCK_KEY), owner, now(), ttlMs)) {
      kv.setItem(LOCK_KEY, JSON.stringify({ owner, at: now() } satisfies LockPayload));
      await delay(settleMs); // 让同一时刻的其它写入落定
      const check = kv.getItem(LOCK_KEY);
      let mine = false;
      try {
        mine = !!check && (JSON.parse(check) as LockPayload).owner === owner;
      } catch {
        mine = false;
      }
      if (mine) break; // 唯一获胜者
      // 被并发者覆盖：本轮落败，退避重试
    }
    if (now() >= deadline) {
      throw new ReviewError("LOCK_BUSY", "另一标签正在保存，本决定已排队，将自动重试");
    }
    await delay(retryMs);
  }

  try {
    return await fn();
  } finally {
    const raw = kv.getItem(LOCK_KEY);
    if (raw) {
      try {
        if ((JSON.parse(raw) as LockPayload).owner === owner) kv.removeItem(LOCK_KEY);
      } catch {
        kv.removeItem(LOCK_KEY);
      }
    }
  }
}

/** 浏览器 localStorage 适配器（含键枚举，用于接管已关闭标签的 outbox） */
export function browserKV(): KV {
  return {
    getItem: (k) => (typeof localStorage === "undefined" ? null : localStorage.getItem(k)),
    setItem: (k, v) => localStorage.setItem(k, v),
    removeItem: (k) => localStorage.removeItem(k),
    keys: () => {
      const out: string[] = [];
      if (typeof localStorage === "undefined") return out;
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k) out.push(k);
      }
      return out;
    },
  };
}

/** 测试/重置用的内存 KV */
export function memoryKV(initial: Record<string, string> = {}): KV {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => (map.has(k) ? map.get(k)! : null),
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
    keys: () => [...map.keys()],
  };
}

/**
 * 可跨实例广播的内存 KV：一个实例 setItem 会通知其它实例（仅其它实例收到），
 * 用于在 Node 中模拟浏览器的 storage 事件。
 */
export function sharedMemoryKV(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  type StorageListener = (key: string, newValue: string | null) => void;
  const instances: { kv: KV; listener?: StorageListener }[] = [];

  function broadcast(from: number, key: string, newValue: string | null) {
    instances.forEach((inst, i) => {
      if (i !== from) inst.listener?.(key, newValue);
    });
  }

  function connect(): KV & { onStorage(l: StorageListener): void } {
    const id = instances.length;
    const inst: { kv: KV; listener?: StorageListener } = {
      kv: {
        getItem: (k) => (map.has(k) ? map.get(k)! : null),
        setItem: (k, v) => {
          map.set(k, v);
          broadcast(id, k, v);
        },
        removeItem: (k) => {
          map.delete(k);
          broadcast(id, k, null);
        },
        keys: () => [...map.keys()],
      },
    };
    instances.push(inst);
    return Object.assign(inst.kv, {
      onStorage(l: StorageListener) {
        inst.listener = l;
      },
    });
  }

  return { connect };
}
