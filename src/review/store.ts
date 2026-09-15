import { applyAction, markAuditSynced } from "./rules";
import { MockServer } from "./server";
import {
  CLIENT_KEY,
  KV,
  loadJSON,
  saveJSON,
} from "./storage";
import type { ReviewAction, ReviewError as ReviewErrorType, ReviewState } from "./types";
import { ReviewError } from "./types";

interface QueuedAction {
  action: ReviewAction;
  opKey: string;
}

interface ClientSnapshot {
  state: ReviewState;
  outbox: QueuedAction[];
  /** opKey -> { actionId, at }：短时窗口内防止重复点击产生第二条决定 */
  recent: Record<string, { actionId: string; at: string }>;
  updatedAt: string;
}

export interface StoreView {
  state: ReviewState;
  online: boolean;
  syncing: boolean;
  outboxCount: number;
  /** 最近一次被拒绝/去重的提示（UI 展示后自动消失） */
  notice: { kind: "error" | "info" | "success"; text: string } | null;
}

type Listener = () => void;

const RECENT_WINDOW_MS = 30_000;

/**
 * 客户端状态中心：
 * - 乐观应用：先本地生效再请求服务端
 * - outbox：断网期间动作排队（含处理人/时间），恢复后按序重放，actionId 服务端去重
 * - 快照：每次变化持久化，刷新后立即恢复界面与待同步记录
 */
export class ReviewStore {
  private server: MockServer;
  private kv: KV;
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

  constructor(server: MockServer, kv: KV, now: () => string = () => new Date().toISOString()) {
    this.server = server;
    this.kv = kv;
    this.now = now;
    this.online = server.online; // 断网模拟状态跨刷新恢复

    const snapshot = loadJSON<ClientSnapshot>(kv, CLIENT_KEY);
    if (snapshot?.state) {
      // 刷新/重开后立即恢复状态、待同步队列与处理记录
      this.state = snapshot.state;
      this.outbox = snapshot.outbox ?? [];
      this.recent = snapshot.recent ?? {};
    } else {
      this.state = server.getState();
    }

    // 页面重开即在线且有未同步队列时（断网期间被直接关闭），自动尝试补传
    if (this.online && this.outbox.length > 0) {
      void this.flush();
    }
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    this.cachedView = null; // 下次 getView 重新构造，保证两次 getSnapshot 间引用稳定
    this.listeners.forEach((fn) => fn());
  }

  private persist(): void {
    const snapshot: ClientSnapshot = {
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
   * 提交一个决定。opKey 相同且在短窗口内（含进行中/排队中）视为重复提交，直接忽略。
   * 返回是否生效；不抛异常，业务拒绝通过 notice 反馈。
   */
  async dispatch(
    action: ReviewAction,
    opKey: string
  ): Promise<{ ok: boolean; deduped?: boolean; code?: string }> {
    // 1) 短时重复提交拦截（双击、网络抖动下的连点）
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
      // 2) 本地规则先校验并乐观应用（权限/冲突门禁/状态机在客户端同样执行）
      let optimistic: ReviewState;
      try {
        optimistic = applyAction(this.state, action);
      } catch (err) {
        const e = err as ReviewErrorType;
        this.setNotice("error", e.code === "DUPLICATE_ACTION" ? "该处理已提交过" : e.message);
        this.emit();
        return { ok: false, code: e.code };
      }
      // 标记新审计为待同步
      const prevIds = new Set(this.state.items.flatMap((i) => i.audit.map((a) => a.id)));
      for (const item of optimistic.items) {
        for (const entry of item.audit) {
          if (!prevIds.has(entry.id)) entry.pendingSync = true; // 服务端确认前显示"待同步"
        }
      }
      this.state = optimistic;
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

      // 4) 在线：请求服务端；网络失败转 outbox，业务拒绝回滚
      try {
        const result = await this.server.dispatch(action);
        // 服务端为权威快照（pendingSync 在服务端版本中不存在）
        this.state = result.state;
        this.persist();
        if (result.deduped) {
          this.setNotice("info", "重复提交已忽略：该处理只生效一次");
        } else {
          this.setNotice("success", "已同步：处理人与时间已记录");
        }
        this.emit();
        return { ok: !result.deduped, deduped: result.deduped };
      } catch (err) {
        const code = (err as ReviewErrorType).code;
        if (code === "NETWORK_OFFLINE") {
          this.online = false;
          this.server.setOnline(false);
          this.outbox.push({ action, opKey });
          this.persist();
          this.setNotice("info", "网络中断，决定已暂存本地，恢复后自动同步");
          this.emit();
          return { ok: true };
        }
        // 服务端业务规则拒绝（与本地规则一致，正常不可达）：以服务端为准回滚
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

    let failedBusiness = 0;
    while (this.outbox.length > 0) {
      const queued = this.outbox[0];
      try {
        const result = await this.server.dispatch(queued.action);
        this.state = result.state;
        this.outbox.shift();
        this.persist();
      } catch (err) {
        const code = (err as ReviewErrorType).code;
        if (code === "NETWORK_OFFLINE") {
          this.online = false;
          this.setNotice("error", "同步中断，仍有决定暂存本地");
          break;
        }
        // 业务拒绝（陈旧动作等）：以服务端为准，丢弃这条永不可能成功的本地动作
        this.state = this.server.getState();
        this.outbox.shift();
        failedBusiness += 1;
        this.persist();
      }
    }

    this.syncing = false;
    if (this.outbox.length === 0) {
      this.state = markAuditSynced(this.state);
      this.persist();
      this.setNotice(
        failedBusiness > 0 ? "info" : "success",
        failedBusiness > 0
          ? `同步完成，${failedBusiness} 条过期决定被服务端规则驳回`
          : "所有处理已同步，处理记录完整保留"
      );
    }
    this.emit();
  }

  /** 网络开关（模拟断网/恢复）。恢复时先拉服务端快照再重放 outbox */
  async setOnline(online: boolean): Promise<void> {
    if (online === this.online) return;
    this.online = online;
    this.server.setOnline(online);
    this.emit();

    if (online) {
      // 先对账：服务端可能已在另一标签页接受了相同动作
      try {
        const serverState = await this.server.fetchState();
        const queued = [...this.outbox];
        const stillQueued: QueuedAction[] = [];
        for (const q of queued) {
          if (serverState.processedActions[q.action.actionId]) continue; // 服务端已有，去重
          stillQueued.push(q);
        }
        this.outbox = stillQueued;
        if (stillQueued.length === 0) {
          this.state = serverState;
          this.persist();
        }
      } catch {
        // 拉取失败则直接依赖重放发现断网
      }
      await this.flush();
    } else {
      this.setNotice("info", "已切换为离线模式，决定将暂存本地");
      this.emit();
    }
  }

  /** 清空本地+服务端数据，恢复演示种子（验证与演示重置用） */
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
