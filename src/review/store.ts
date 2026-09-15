import { applyAction, markAuditSynced } from "./rules";
import { MockServer } from "./server";
import {
  CLIENT_KEY,
  KV,
  SETTINGS_KEY,
  SERVER_KEY,
  loadLegacySnapshot,
  loadLocalData,
  loadState,
  localKey,
  listLocalClientIds,
  saveLocalData,
  scanStaleOutboxes,
} from "./storage";
import type {
  DispatchResult,
  ReviewAction,
  ReviewError as ReviewErrorType,
  ReviewState,
} from "./types";

interface QueuedAction {
  action: ReviewAction;
  opKey: string;
}

export interface StoreView {
  state: ReviewState;
  online: boolean;
  syncing: boolean;
  outboxCount: number;
  notice: { kind: "error" | "info" | "success"; text: string } | null;
}

type Listener = () => void;

/** 单条排队动作的发送结果 */
type SendOutcome = "sent" | "deduped" | "queued" | string; // string = 业务拒绝码

const RECENT_WINDOW_MS = 30_000;
const LOCK_RETRY_DELAY_MS = 400; // 锁忙后的本地退避
const RETRY_DELAY_MS = 1_200; // 其它临时性失败后的重试
const HEARTBEAT_MS = 2_000;
const TAKEOVER_INTERVAL_MS = 5_000;
const CLIENT_STALE_MS = 8_000;

/** 供 Node 中共享内存 KV 注入的 storage 事件钩子 */
type StorageHookKV = KV & { onStorage?(l: (key: string, value: string | null) => void): void };

let clientSeq = 0;

/**
 * 客户端状态中心（每个浏览器标签页一个实例）。
 *
 * 不丢失：通过本地校验的决定都【先写入本标签 outbox 键并持久化】再发送，
 *   服务端确认后才摘除；断网、锁忙、刷新、标签关闭都不丢。标签失活（心跳超时）后，
 *   其遗留 outbox 由存活标签接管补传（actionId 幂等保证不会重复）。
 * 不重复：服务端 actionId 幂等 + 同内容冲突幂等；outbox 重放/接管/多标签重发安全。
 * 顺序：本标签发送经同一条串行泵；跨标签由服务端存储锁串行，
 *   每次落库在锁内重读最新状态后应用（rev 单调自增）。
 */
export class ReviewStore {
  private server: MockServer;
  private kv: StorageHookKV;
  /** 本标签 id：同一标签刷新后复用（浏览器中存 sessionStorage），不同标签各自独立 */
  readonly clientId: string;
  state: ReviewState;
  private outbox: QueuedAction[] = [];
  private recent: Record<string, { actionId: string; at: string }> = {};
  online = true;
  syncing = false;
  notice: StoreView["notice"] = null;
  private listeners = new Set<Listener>();
  private inflight = new Set<string>();
  private now: () => string;
  private nowMs: () => number;
  private cachedView: StoreView | null = null;
  private chain: Promise<void> = Promise.resolve();
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private takeoverTimer: ReturnType<typeof setInterval> | null = null;
  private closed = false;
  /** actionId -> 提交方等待结果的回调 */
  private resolvers = new Map<string, (o: SendOutcome) => void>();

  constructor(
    server: MockServer,
    kv: KV,
    opts: { now?: () => string; nowMs?: () => number; clientId?: string } = {}
  ) {
    this.server = server;
    this.kv = kv as StorageHookKV;
    this.now = opts.now ?? (() => new Date().toISOString());
    this.nowMs = opts.nowMs ?? (() => Date.now());
    this.clientId =
      opts.clientId ??
      `tab-${++clientSeq}-${Math.random().toString(36).slice(2, 8)}`;

    this.online = server.isOnline();

    // 1) 本标签自己的持久数据（刷新恢复）；没有则尝试一次性迁移旧版共用快照
    const own = loadLocalData(this.kv, this.clientId);
    if (own) {
      this.state = own.state;
      this.outbox = own.outbox ?? [];
      this.recent = own.recent ?? {};
    } else {
      const legacy = loadLegacySnapshot(this.kv);
      if (legacy) {
        this.state = legacy.state;
        this.outbox = legacy.outbox ?? [];
        this.recent = legacy.recent ?? {};
        this.kv.removeItem(CLIENT_KEY); // 旧共用快照由首个标签认领后移除
      } else {
        this.state = server.getState();
      }
    }

    // 2) 接管已关闭/失活标签遗留的队列
    this.adoptStaleOutboxes();

    // 与服务端最新状态对账：已落库的排队动作摘除，其余重放为待同步视图
    this.reconcileWith(server.getState());

    // 浏览器 storage 事件 / Node 共享内存 KV 钩子
    if (typeof window !== "undefined" && window.addEventListener) {
      window.addEventListener("storage", (e) => {
        if (!e.key) return;
        if (e.key === SERVER_KEY) this.handleExternalState();
        if (e.key === SETTINGS_KEY) this.handleExternalSettings(e.newValue);
      });
    }
    this.kv.onStorage?.((key) => {
      if (key === SERVER_KEY) this.handleExternalState();
      if (key === SETTINGS_KEY) this.handleExternalSettings(null);
    });

    // 3) 心跳 + 周期接管；先落一次盘证明本标签存活
    this.persist();
    this.startTimers();

    if (this.online && this.outbox.length > 0) {
      this.runPump();
    }
  }

  private startTimers(): void {
    if (typeof setInterval === "undefined") return;
    this.heartbeatTimer = setInterval(() => this.heartbeat(), HEARTBEAT_MS);
    this.takeoverTimer = setInterval(() => this.adoptStaleOutboxes(), TAKEOVER_INTERVAL_MS);
    // Node 验证环境下定时器不阻止进程退出（浏览器无 unref）
    for (const t of [this.heartbeatTimer, this.takeoverTimer]) {
      (t as { unref?: () => void }).unref?.();
    }
  }

  /** 测试用：模拟标签被关闭（停止心跳，但保留 outbox 键等待接管） */
  closeClient(): void {
    this.closed = true;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.takeoverTimer) clearInterval(this.takeoverTimer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.heartbeatTimer = null;
    this.takeoverTimer = null;
    this.retryTimer = null;
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
    saveLocalData(this.kv, {
      clientId: this.clientId,
      state: this.state,
      outbox: this.outbox,
      recent: this.recent,
      heartbeat: this.nowMs(),
      updatedAt: this.now(),
    });
  }

  private heartbeat(): void {
    if (this.closed) return;
    this.persist(); // 仅刷新心跳时间
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

  /** 以服务端最新状态为基底，重放本地未同步动作，构造乐观视图（不改 outbox） */
  private buildRebasedState(serverState: ReviewState): ReviewState {
    const baseIds = new Set(serverState.items.flatMap((i) => i.audit.map((a) => a.id)));
    let view = serverState;
    for (const queued of this.outbox) {
      if (view.processedActions[queued.action.actionId]) continue;
      try {
        const r = applyAction(view, queued.action);
        if (r.outcome === "conflict_deduped") continue;
        view = r.state;
      } catch {
        // 过期/非法的排队动作在对账视图中忽略；sendOne 中正式摘除
      }
    }
    for (const item of view.items) {
      for (const entry of item.audit) {
        if (!baseIds.has(entry.id)) entry.pendingSync = true;
      }
    }
    return view;
  }

  /** 以服务端快照为准：摘除已处理排队动作，重放剩余 outbox 生成乐观视图 */
  private reconcileWith(serverState: ReviewState): void {
    this.outbox = this.outbox.filter(
      (q) => !serverState.processedActions[q.action.actionId]
    );
    this.state =
      this.outbox.length > 0 ? this.buildRebasedState(serverState) : serverState;
  }

  /** 其它标签提交了决定（或服务端库被外部更新） */
  private handleExternalState(): void {
    if (this.closed) return;
    const serverState = loadState(this.kv, SERVER_KEY);
    if (!serverState) return;

    const settled = this.outbox.filter((q) =>
      serverState.processedActions[q.action.actionId]
    );
    this.reconcileWith(serverState);
    for (const q of settled) this.resolveOne(q.action.actionId, "deduped");
    this.persist();
    this.emit();
  }

  /** 其它标签切换了在线/断网开关 */
  private handleExternalSettings(raw: string | null): void {
    if (this.closed) return;
    const source = raw ?? this.kv.getItem(SETTINGS_KEY);
    let online = true;
    if (source) {
      try {
        online = (JSON.parse(source) as { online?: boolean }).online !== false;
      } catch {
        online = true;
      }
    }
    if (online === this.online) return;
    this.online = online;
    this.server.setOnline(online);
    if (online) this.runPump();
    this.emit();
  }

  /** 接管失活标签遗留的 outbox（按 actionId 去重合并，删除其本地键） */
  private adoptStaleOutboxes(): void {
    if (this.closed || !this.kv.keys) return;
    const stale = scanStaleOutboxes(this.kv, this.clientId, this.nowMs(), CLIENT_STALE_MS);
    if (stale.length === 0) return;

    let adopted = 0;
    const known = new Set([
      ...this.outbox.map((q) => q.action.actionId),
      ...Object.keys(this.state.processedActions ?? {}),
    ]);
    for (const { clientId, outbox } of stale) {
      for (const q of outbox) {
        if (known.has(q.action.actionId)) continue;
        // 服务端已处理的也不接管
        if (this.server.getState().processedActions[q.action.actionId]) continue;
        this.outbox.push(q);
        known.add(q.action.actionId);
        adopted += 1;
      }
      this.kv.removeItem(localKey(clientId)); // 接管后删除，避免被重复接管
    }
    if (adopted > 0) {
      this.persist();
      this.setNotice("info", `已自动接管已关闭标签遗留的 ${adopted} 条待同步决定`);
      this.emit();
      if (this.online) this.runPump();
    }
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
    const age = hit ? this.nowMs() - Date.parse(hit.at) : Infinity;
    if ((hit && age < RECENT_WINDOW_MS) || this.inflight.has(opKey)) {
      this.setNotice("info", "重复提交已忽略：该处理只生效一次");
      this.emit();
      return { ok: false, deduped: true, code: "DUPLICATE_ACTION" };
    }
    this.inflight.add(opKey);
    this.recent[opKey] = { actionId: action.actionId, at: action.at };

    try {
      // 2) 本地规则先校验
      const trial = applyAction(this.state, action);

      // 内容级幂等：相同未关闭冲突已存在 → 不新增、不入队。
      // 经同一条串行链告知服务端登记 actionId（与泵写互斥），取回权威快照。
      if (trial.outcome === "conflict_deduped") {
        if (this.online) {
          this.chain = this.chain.then(async () => {
            try {
              const result = await this.server.dispatch(action);
              this.state = result.state;
              this.persist();
            } catch (err) {
              if ((err as ReviewErrorType).code === "NETWORK_OFFLINE") {
                this.online = false;
                this.server.setOnline(false);
              }
              // 锁忙/其它失败不必排队：内容已存在，未来同内容提交仍会被去重
            }
          });
          await this.chain;
        }
        this.setNotice("info", "相同内容的未关闭冲突已存在，只保留一条记录");
        this.emit();
        return { ok: false, deduped: true, code: "DUPLICATE_CONFLICT" };
      }

      // 3) 乐观应用并标记待同步
      const prevIds = new Set(this.state.items.flatMap((i) => i.audit.map((a) => a.id)));
      this.state = trial.state;
      for (const item of this.state.items) {
        for (const entry of item.audit) {
          if (!prevIds.has(entry.id)) entry.pendingSync = true;
        }
      }

      // 4) 发送【之前】先入本标签 outbox 并持久化（at-least-once），确认后才摘除
      const queued: QueuedAction = { action, opKey };
      this.outbox.push(queued);
      this.emit();
      this.persist();

      if (!this.online) {
        this.setNotice("info", "当前离线，决定已记录，将在恢复网络后同步");
        this.emit();
        return { ok: true };
      }

      // 5) 经唯一串行泵发送，等待本条动作的结果
      const outcome = await this.enqueueAndPump(queued);
      if (outcome === "sent") {
        this.setNotice("success", "已同步：处理人与时间已记录");
        return { ok: true };
      }
      if (outcome === "queued") {
        return { ok: true }; // 断网/锁忙：已安全排队，后台自动重试
      }
      if (outcome === "deduped") {
        this.setNotice("info", "重复提交已忽略：该处理只生效一次");
        return { ok: false, deduped: true, code: "DUPLICATE_ACTION" };
      }
      return { ok: false, code: outcome }; // 业务拒绝：sendOne 已回滚
    } catch (err) {
      const e = err as ReviewErrorType;
      this.setNotice("error", e.code === "DUPLICATE_ACTION" ? "该处理已提交过" : e.message);
      this.emit();
      return { ok: false, code: e.code };
    } finally {
      this.inflight.delete(opKey);
    }
  }

  private resolveOne(actionId: string, outcome: SendOutcome): void {
    const resolve = this.resolvers.get(actionId);
    if (resolve) {
      this.resolvers.delete(actionId);
      resolve(outcome);
    }
  }

  /** 登记等待者并触发串行泵，await 到本条动作的最终结果 */
  private enqueueAndPump(queued: QueuedAction): Promise<SendOutcome> {
    const done = new Promise<SendOutcome>((resolve) => {
      this.resolvers.set(queued.action.actionId, resolve);
    });
    this.runPump();
    return done;
  }

  /** 串行处理整条 outbox（提交、恢复网络、页面重开、锁忙重试、接管的唯一发送入口） */
  private runPump(): void {
    if (this.closed) return;
    if (!this.online || this.outbox.length === 0) {
      this.resolvers.forEach((resolve) => resolve("queued"));
      this.resolvers.clear();
      return;
    }
    this.syncing = true;
    this.emit();

    this.chain = this.chain.then(async () => {
      let rejected = 0;
      let lockBusy = false;
      while (this.outbox.length > 0 && this.online) {
        const queued = this.outbox[0];
        const outcome = await this.sendOne(queued);
        if (outcome === "queued") {
          lockBusy = true;
          break; // 断网/锁忙：保留剩余，等待重试
        }
        if (outcome === "sent" || outcome === "deduped") {
          this.resolveOne(queued.action.actionId, outcome);
        } else {
          rejected += 1;
          this.resolveOne(queued.action.actionId, outcome);
        }
      }

      // 仍排队动作的本次提交者告知"已排队"（后台继续重试）
      for (const q of this.outbox) this.resolveOne(q.action.actionId, "queued");

      this.syncing = false;
      if (this.outbox.length === 0) {
        this.state = markAuditSynced(this.state);
        this.persist();
        if (rejected === 0) {
          this.setNotice("success", "所有处理已同步，处理记录完整保留");
        } else {
          this.setNotice("info", `同步完成，${rejected} 条过期决定被服务端规则驳回`);
        }
      }
      this.emit();

      if (this.outbox.length > 0 && this.online && !this.closed) {
        this.scheduleRetry(lockBusy ? LOCK_RETRY_DELAY_MS : RETRY_DELAY_MS);
      }
    });
  }

  private scheduleRetry(delay: number): void {
    if (this.retryTimer) return;
    const timer = setTimeout(() => {
      this.retryTimer = null;
      this.runPump();
    }, delay);
    (timer as { unref?: () => void }).unref?.();
    this.retryTimer = timer;
  }

  /**
   * 发送队首动作（仅在串行链内调用）：
   * - sent/deduped：服务端已登记 actionId → 摘除
   * - queued：断网或锁忙 → 保留并安排重试
   * - 业务拒绝码：永不可能成功 → 摘除并以服务端为准
   */
  private async sendOne(queued: QueuedAction): Promise<SendOutcome> {
    let result: DispatchResult;
    try {
      result = await this.server.dispatch(queued.action);
    } catch (err) {
      const code = (err as ReviewErrorType).code;
      if (code === "NETWORK_OFFLINE") {
        this.online = false;
        this.server.setOnline(false);
        this.setNotice("error", "网络中断，决定已暂存本地，恢复后自动同步");
        this.emit();
        return "queued";
      }
      if (code === "LOCK_BUSY") {
        this.setNotice("info", "另一标签正在保存，本决定已排队，将随即写入");
        this.emit();
        return "queued";
      }
      // 业务规则拒绝：以服务端为准，摘除这条本地动作；剩余 outbox 重放为乐观视图
      const fresh = this.server.getState();
      this.removeFromOutbox(queued.action.actionId);
      this.state = this.outbox.length > 0 ? this.buildRebasedState(fresh) : fresh;
      this.persist();
      return code ?? "REJECTED";
    }

    // 锁内返回的是最新权威快照；队列还有未发动作时，在其上重放剩余 outbox，
    // 保证"待同步"决定在整个发送过程中始终可见（不会在中间快照里短暂消失）
    this.removeFromOutbox(queued.action.actionId);
    this.state =
      this.outbox.length > 0 ? this.buildRebasedState(result.state) : result.state;
    this.persist();
    this.emit();
    return result.deduped || result.conflictDeduped ? "deduped" : "sent";
  }

  private removeFromOutbox(actionId: string): void {
    this.outbox = this.outbox.filter((q) => q.action.actionId !== actionId);
  }

  /** 供外部等待当前队列排空（测试用） */
  flushed(): Promise<void> {
    return this.chain;
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
        const settled = this.outbox.filter((q) =>
          serverState.processedActions[q.action.actionId]
        );
        this.reconcileWith(serverState);
        for (const q of settled) this.resolveOne(q.action.actionId, "deduped");
        this.persist();
      } catch {
        // 拉取失败则直接依赖重放发现断网
      }
      this.runPump();
      await this.chain;
    } else {
      this.setNotice("info", "已切换为离线模式，决定将暂存本地");
      this.emit();
    }
  }

  /** 清空本地（所有标签键）+ 服务端数据，恢复演示种子 */
  resetAll(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.takeoverTimer) clearInterval(this.takeoverTimer);
    this.retryTimer = null;
    this.heartbeatTimer = null;
    this.takeoverTimer = null;
    this.state = this.server.reset();
    this.outbox = [];
    this.recent = {};
    this.notice = null;
    this.online = true;
    this.syncing = false;
    this.closed = false;
    this.resolvers.forEach((resolve) => resolve("queued"));
    this.resolvers.clear();
    // 删除本域所有标签的本地键与旧版共用快照
    this.kv.removeItem(CLIENT_KEY);
    for (const id of listLocalClientIds(this.kv)) this.kv.removeItem(localKey(id));
    this.persist();
    this.startTimers();
    this.emit();
  }
}
