import type { ReviewState } from "./types";

/** 版本化持久化。浏览器用 localStorage，Node 验证时可注入内存实现 */
export interface KV {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
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

/** v1（旧版）→ v2：补 rev；processedActions 旧值可能是审计 id，归一为 actionId */
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

export function loadState(kv: KV, key: string = SERVER_KEY): ReviewState | null {
  const raw = kv.getItem(key);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as ReviewState;
    if (!Array.isArray(parsed.items)) return null;
    return parsed.version === 2 && typeof parsed.rev === "number"
      ? parsed
      : migrateState(parsed);
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
 * 读取客户端快照。旧数据兼容：
 * - 无 version 字段的 v1 快照：其中的 state 同样做迁移；outbox/recent 缺失则补空
 */
export function loadClientSnapshot(kv: KV): ClientSnapshot | null {
  const snap = loadJSON<ClientSnapshot>(kv, CLIENT_KEY);
  if (!snap || !snap.state) return null;
  const state =
    snap.state.version === 2 && typeof snap.state.rev === "number"
      ? snap.state
      : migrateState(snap.state);
  return {
    version: snap.version ?? 1,
    state,
    outbox: Array.isArray(snap.outbox) ? snap.outbox : [],
    recent: snap.recent ?? {},
    updatedAt: snap.updatedAt ?? "",
  };
}

const LOCK_TTL_MS = 4_000;
const LOCK_WAIT_MS = 1_500;
const LOCK_RETRY_MS = 25;

interface LockPayload {
  owner: string;
  at: number;
}

/** 跨标签互斥（同一 KV/localStorage）；TTL 防死锁。仅保护 dispatch 的读改写窗口 */
export async function withServerLock<T>(
  kv: KV,
  owner: string,
  fn: () => T | Promise<T>,
  now: () => number = Date.now
): Promise<T> {
  const deadline = now() + LOCK_WAIT_MS;
  for (;;) {
    const raw = kv.getItem(LOCK_KEY);
    let acquired = false;
    if (!raw) {
      acquired = true;
    } else {
      try {
        const lock = JSON.parse(raw) as LockPayload;
        if (lock.owner === owner || now() - lock.at > LOCK_TTL_MS) acquired = true;
      } catch {
        kv.removeItem(LOCK_KEY);
        acquired = true;
      }
    }
    if (acquired) {
      const payload: LockPayload = { owner, at: now() };
      kv.setItem(LOCK_KEY, JSON.stringify(payload));
      // 写入后再读一次，确认锁未被另一标签抢走（两次 setItem 交错时）
      const check = kv.getItem(LOCK_KEY);
      if (check && JSON.parse(check).owner === owner) break;
    }
    if (now() >= deadline) {
      throw Object.assign(new Error("保存冲突，请稍后重试"), { code: "LOCK_BUSY" });
    }
    await new Promise((r) => setTimeout(r, LOCK_RETRY_MS));
  }

  try {
    return await fn();
  } finally {
    const raw = kv.getItem(LOCK_KEY);
    if (raw) {
      try {
        if (JSON.parse(raw).owner === owner) kv.removeItem(LOCK_KEY);
      } catch {
        kv.removeItem(LOCK_KEY);
      }
    }
  }
}

/** 测试/重置用的内存 KV，并记录 storage 事件回调（模拟跨标签 storage 事件） */
export function memoryKV(initial: Record<string, string> = {}): KV {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => (map.has(k) ? map.get(k)! : null),
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
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
