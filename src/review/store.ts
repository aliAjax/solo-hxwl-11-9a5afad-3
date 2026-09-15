import { applyAction, markAuditSynced } from "./rules";
import { MockServer } from "./server";
import {
  CLIENT_KEY,
  KV,
  SETTINGS_KEY,
  SERVER_KEY,
  loadClientSnapshot,
  loadState,
  saveJSON,
} from "./storage";
import type {
  ReviewAction,
  ReviewError as ReviewErrorType,
  ReviewState,
} from "./types";
import { ReviewError } from "./types";

interface QueuedAction {
  action: ReviewAction;
  opKey: string;
}

interface ClientSnapshotData {
  state: ReviewState;
  outbox: QueuedAction[];
  recent: Record<string, { actionId: string; at: string }>;
  updatedAt: string;
}

export interface StoreView {
  state: ReviewState;
  online: boolean;
  syncing: boolean;
  outboxCount: number;
  notice: { kind: "error" | "info" | "success"; text: string } | null;
}

type Listener = () => void;

const RECENT_WINDOW_MS = 30_000;

/** 供 Node 中共享内存 KV 注入的 storage 事件钩子 */
type StorageHookKV = KV & { onStorage?(l: (key: string, value: string | null) => void): void };

/**
 * 客户端状态中心：
 * - 乐观应用：先本地生效再请求服务端
 * - outbox：断网期间动作排队（含真实处理人/操作时刻），恢复后按序重放，服务端按 actionId 去重
 * - 跨标签：监听共享存储（storage 事件），用其它标签已落库的最新状态为基底，rebase 本地 outbox，
 *   保证两个标签并发提交的不同决定都不丢失
 * - 快照持久化：刷新/重开后立即恢复界面、待同步队列与处理记录
 */
export class ReviewStore {
  private server: MockServer;
  private kv: StorageHookKV;
  state: ReviewState;
  private outbox: QueuedAction[] = [];
  private recent: Record<string, { actionId: string; at: string }> = {};
  online = true;
  syncing = false;
  notice: StoreView["notice"] = null;
  private listeners = new Set<Listener>();
  private inflight = new Set<string>();
  private now: () => string;
  private cachedView: StoreView | null = null;

  constructor(
    server: MockServer,
    kv: KV,
    now: () => string = () => new Date().toISOString()
  ) {
    this.server = server;
    this.kv = kv as StorageHookKV;
    this.now = now;
    this.online = server.isOnline();

    const snapshot = loadClientSnapshot(this.kv);
    if (snapshot) {
      this.state = snapshot.state;
      this.outbox = snapshot.outbox ?? [];
      this.recent = snapshot.recent ?? {};
    } else {
      this.state = server.getState();
    }

    // 浏览器：其它标签写 localStorage；Node：共享内存 KV 的钩子
    if (typeof window !== "undefined" && window.addEventListener) {
      window.addEventListener("storage", (e) => {
        if (!e.key) return;
        if (e.key === SERVER_KEY) this.handleExternalState(e.newValue);
        if (e.key === SETTINGS_KEY) this.handleExternalSettings(e.newValue);
      });
    }
    this.kv.onStorage?.((key, value) => {
      if (key === SERVER_KEY) this.handleExternalState(value);
      if (key === SETTINGS_KEY) this.handleExternalSettings(value);
    });

    // 页面重开即在线且有未同步队列时（断网期间被直接关闭），自动补传
    if (this.online && this.outbox.length > 0) {
      void this.flush();
    }
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    this.cachedView = null;
    this.listeners.forEach((fn) => fn());
  }

  private persist(): void {
    const snapshot: ClientSnapshotData = {
      state: this.state,
      outbox: this.outbox,
      recent: this.recent,
      updatedAt: this.now(),
    };
    saveJSON(this.kv, CLIENT_KEY, snapshot);
  }

  getView(): StoreView {
    if (!this.cachedView) {
      this.cachedView = {
        state: this.state,
        online: this.online,
        syncing: this.syncing,
        outboxCount: this.outbox.length,
        notice: this.notice,
      };
    }
    return this.cachedView;
  }

  clearNotice(): void {
    this.notice = null;
    this.emit();
  }

  private setNotice(kind: "error" | "info" | "success", text: string): void {
    this.notice = { kind, text };
  }

  /**
   * 以服务端最新状态为基底，重放本地未同步动作，构造乐观视图（不改 outbox）。
   * 其它标签落库的决定与本标签排队中的决定因此同时可见、互不覆盖。
   */
  private buildRebasedState(serverState: ReviewState): ReviewState {
    const baseIds = new Set(serverState.items.flatMap((i) => i.audit.map((a) => a.id)));
    let view = serverState;
    for (const queued of this.outbox) {
      if (view.processedActions[queued.action.actionId]) continue;
      try {
        const r = applyAction(view, queued.action);
        if (r.outcome === "conflict_deduped") continue; // 内容幂等命中：无本地效果
        view = r.state;
      } catch {
        // 过期/非法的排队动作在对账视图中忽略；flush 时会被正式剔除
      }
    }
    for (const item of view.items) {
      for (const entry of item.audit) {
        if (!baseIds.has(entry.id)) entry.pendingSync = true;
      }
    }
    return view;
  }

  /** 其它标签提交了决定（或服务端库被外部更新） */
  private handleExternalState(raw: string | null): void {
    let serverState: ReviewState | null = null;
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as ReviewState;
        if (Array.isArray(parsed.items)) {
          serverState =
            parsed.version === 2 && typeof parsed.rev === "number"
              ? parsed
              : loadState(this.kv, SERVER_KEY);
        }
      } catch {
        serverState = loadState(this.kv, SERVER_KEY);
      }
    } else {
      serverState = loadState(this.kv, SERVER_KEY);
    }
    if (!serverState) return;

    // 已被其它标签（或服务端）处理的排队动作剔除
    this.outbox = this.outbox.filter((q) => !serverState!.processedActions[q.action.actionId]);

    if (this.outbox.length > 0) {
      this.state = this.buildRebasedState(serverState);
    } else {
      this.state = serverState;
    }
    this.persist();
    this.emit();
  }

  /** 其它标签切换了在线/断网开关 */
  private handleExternalSettings(raw: string | null): void {
    const online = raw ? (JSON.parse(raw) as { online?: boolean }).online !== false : true;
    if (online === this.online) return;
    this.online = online;
    this.server.setOnline(online);
    if (online) void this.flush();
    this.emit();
  }

  /**
   * 提交一个决定。opKey 相同且在短窗口内（含进行中）视为重复提交，直接忽略。
   */
  async dispatch(
    action: ReviewAction,
    opKey: string
  ): Promise<{ ok: boolean; deduped?: boolean; code?: string }> {
    // 1) 短时重复提交拦截（双击、网络抖动连点）
    const hit = this.recent[opKey];
    const age = hit ? Date.now() - Date.parse(hit.at) : Infinity;
    if ((hit && age < RECENT_WINDOW_MS) || this.inflight.has(opKey)) {
      this.setNotice("info", "重复提交已忽略：该处理只生效一次");
      this.emit();
      return { ok: false, deduped: true, code: "DUPLICATE_ACTION" };
    }
    this.inflight.add(opKey);
    this.recent[opKey] = { actionId: action.actionId, at: action.at };

    try {
      // 2) 本地规则先校验并乐观应用
      let optimisticResult;
      try {
        optimisticResult = applyAction(this.state, action);
      } catch (err) {
        const e = err as ReviewErrorType;
        this.setNotice(
          "error",
          e.code === "DUPLICATE_ACTION" ? "该处理已提交过" : e.message
        );
        this.emit();
        return { ok: false, code: e.code };
      }

      // 内容级幂等：相同未关闭冲突已存在，本地也不新增、不入队
      if (optimisticResult.outcome === "conflict_deduped") {
        this.state = optimisticResult.state;
        this.persist();
        if (!this.online) {
          this.setNotice("info", "相同内容的未关闭冲突已存在，未重复登记");
          this.emit();
          return { ok: false, deduped: true, code: "DUPLICATE_CONFLICT" };
        }
        const result = await this.server.dispatch(action);
        this.state = result.state;
        this.persist();
        this.setNotice("info", "相同内容的未关闭冲突已存在，只保留一条记录");
        this.emit();
        return { ok: false, deduped: true, code: "DUPLICATE_CONFLICT" };
      }

      // 标记新审计为待同步
      const prevIds = new Set(this.state.items.flatMap((i) => i.audit.map((a) => a.id)));
      this.state = optimisticResult.state;
      for (const item of this.state.items) {
        for (const entry of item.audit) {
          if (!prevIds.has(entry.id)) entry.pendingSync = true;
        }
      }
      this.emit();
      this.persist();

      // 3) 离线：进 outbox 等待重放
      if (!this.online) {
        this.outbox.push({ action, opKey });
        this.persist();
        this.setNotice("info", "当前离线，决定已记录，将在恢复网络后同步");
        this.emit();
        return { ok: true };
      }

      // 4) 在线：服务端在锁内以最新状态落库（并发标签的决定都包含在返回快照里）
      try {
        const result = await this.server.dispatch(action);
        this.state = result.state;
        this.persist();
        if (result.deduped) {
          this.setNotice("info", "重复提交已忽略：该处理只生效一次");
        } else if (result.conflictDeduped) {
          this.setNotice("info", "相同内容的未关闭冲突已存在，只保留一条记录");
        } else {
          this.setNotice("success", "已同步：处理人与时间已记录");
        }
        this.emit();
        return {
          ok: !result.deduped && !result.conflictDeduped,
          deduped: result.deduped || result.conflictDeduped,
        };
      } catch (err) {
        const code = (err as ReviewErrorType).code;
        if (code === "NETWORK_OFFLINE") {
          this.online = false;
          this.outbox.push({ action, opKey });
          this.persist();
          this.setNotice("info", "网络中断，决定已暂存本地，恢复后自动同步");
          this.emit();
          return { ok: true };
        }
        if (code === "LOCK_BUSY") {
          // 锁竞争：转本地排队，稍后重放，保证决定不丢
          this.outbox.push({ action, opKey });
          this.persist();
          void this.flush();
          this.setNotice("info", "另一标签正在保存，本决定已排队，将随即写入");
          this.emit();
          return { ok: true };
        }
        // 服务端业务规则拒绝：以服务端为准回滚
        this.state = this.server.getState();
        this.persist();
        this.setNotice("error", (err as Error).message);
        this.emit();
        return { ok: false, code };
      }
    } finally {
      this.inflight.delete(opKey);
    }
  }

  /** 重放 outbox；按序提交，遇断网停下保留剩余动作 */
  async flush(): Promise<void> {
    if (this.syncing || !this.online || this.outbox.length === 0) return;
    this.syncing = true;
    this.emit();

    let dropped = 0;
    while (this.outbox.length > 0) {
      const queued = this.outbox[0];
      try {
        const result = await this.server.dispatch(queued.action);
        this.state = result.state;
        this.outbox.shift();
        this.persist();
        if (result.conflictDeduped) dropped += 0; // 内容幂等：正常无效果，不计异常
      } catch (err) {
        const code = (err as ReviewErrorType).code;
        if (code === "NETWORK_OFFLINE" || code === "LOCK_BUSY") {
          if (code === "NETWORK_OFFLINE") this.online = false;
          this.setNotice("error", "同步中断，仍有决定暂存本地，稍后自动重试");
          break;
        }
        // 业务拒绝（含 actionId 重复、同内容冲突已关需重开等陈旧动作）：
        // 以服务端为准，丢弃这条本地动作
        this.state = this.server.getState();
        this.outbox.shift();
        dropped += 1;
        this.persist();
      }
    }

    this.syncing = false;
    if (this.outbox.length === 0) {
      this.state = markAuditSynced(this.state);
      this.persist();
      this.setNotice(
        "success",
        dropped > 0
          ? `同步完成，${dropped} 条过期决定被服务端规则驳回`
          : "所有处理已同步，处理记录完整保留"
      );
    }
    this.emit();

    // 仍排队（断网/锁忙）时短延迟自动重试
    if (this.outbox.length > 0 && this.online) {
      setTimeout(() => void this.flush(), 1200);
    }
  }

  /** 网络开关（模拟断网/恢复）。恢复时先与服务端对账再重放 outbox */
  async setOnline(online: boolean): Promise<void> {
    if (online === this.online) return;
    this.online = online;
    this.server.setOnline(online);
    this.emit();

    if (online) {
      try {
        const serverState = await this.server.fetchState();
        this.outbox = this.outbox.filter(
          (q) => !serverState.processedActions[q.action.actionId]
        );
        this.state =
          this.outbox.length > 0 ? this.buildRebasedState(serverState) : serverState;
        this.persist();
      } catch {
        // 拉取失败则直接依赖重放发现断网
      }
      await this.flush();
    } else {
      this.setNotice("info", "已切换为离线模式，决定将暂存本地");
      this.emit();
    }
  }

  /** 清空本地+服务端数据，恢复演示种子 */
  resetAll(): void {
    this.state = this.server.reset();
    this.outbox = [];
    this.recent = {};
    this.notice = null;
    this.online = true;
    this.kv.removeItem(CLIENT_KEY);
    this.emit();
  }
}
