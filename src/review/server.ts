import { applyAction } from "./rules";
import { seedState } from "./seed";
import {
  KV,
  LOCK_KEY,
  LockOptions,
  SETTINGS_KEY,
  SERVER_KEY,
  loadJSON,
  loadState,
  saveState,
  saveJSON,
  withServerLock,
} from "./storage";
import type { DispatchResult, ReviewAction, ReviewState } from "./types";
import { ReviewError } from "./types";

let ownerSeq = 0;

/**
 * 模拟后端：权威状态保存在共享 KV（浏览器中即 localStorage，天然跨标签共享）。
 *
 * 并发保存：每次 dispatch 在跨标签锁内【重新读取最新状态】→ apply → 写回并自增 rev。
 * 两个标签页同时提交不同决定时，两者都进入临界区顺序落库，谁也不会覆盖谁。
 *
 * 幂等：
 * - 同一 actionId 只生效一次（断网重放/刷新后重放安全）
 * - 同事项同指标同说明的未关闭冲突只保留一条（规则引擎内内容级去重）
 *
 * 断网：online=false 时请求一律失败，服务端库不变；动作由客户端 outbox 暂存。
 */
export class MockServer {
  private kv: KV;
  private owner: string;
  online = true;
  latencyMs: number;
  lock: LockOptions;

  constructor(kv: KV, opts: { latencyMs?: number; lock?: LockOptions } = {}) {
    this.kv = kv;
    this.latencyMs = opts.latencyMs ?? 120;
    this.lock = opts.lock ?? {};
    this.owner = `srv-${++ownerSeq}-${Math.random().toString(36).slice(2, 7)}`;

    if (!loadState(kv, SERVER_KEY)) {
      saveState(kv, SERVER_KEY, seedState()); // 服务端库初始化（种子为最新结构）
    }
    this.online = loadJSON<{ online: boolean }>(kv, SETTINGS_KEY)?.online ?? true;
  }

  /** 读取共享库中的权威状态（始终读最新，不缓存） */
  getState(): ReviewState {
    return loadState(this.kv, SERVER_KEY) ?? seedState();
  }

  isOnline(): boolean {
    return this.online;
  }

  setOnline(online: boolean): void {
    this.online = online;
    saveJSON(this.kv, SETTINGS_KEY, { online });
  }

  reset(): ReviewState {
    const fresh = seedState();
    this.online = true;
    saveState(this.kv, SERVER_KEY, fresh);
    saveJSON(this.kv, SETTINGS_KEY, { online: true });
    this.kv.removeItem(LOCK_KEY); // 演示重置时一并清理可能残留的锁
    return fresh;
  }

  private delay(): Promise<void> {
    if (this.latencyMs <= 0) return Promise.resolve();
    return new Promise((resolve) => setTimeout(resolve, this.latencyMs));
  }

  async fetchState(): Promise<ReviewState> {
    await this.delay();
    if (!this.online) throw new ReviewError("NETWORK_OFFLINE", "网络已断开");
    return this.getState();
  }

  async dispatch(action: ReviewAction): Promise<DispatchResult> {
    await this.delay();
    if (!this.online) throw new ReviewError("NETWORK_OFFLINE", "网络已断开，动作暂存本地");

    return withServerLock(
      this.kv,
      this.owner,
      () => {
        // 临界区内重新读取：拿到的是其它标签刚刚落库的最新状态
        const current = loadState(this.kv, SERVER_KEY) ?? seedState();

        if (current.processedActions[action.actionId]) {
          return { state: current, deduped: true };
        }

        const result = applyAction(current, action);
        const next: ReviewState = { ...result.state, rev: current.rev + 1 };
        saveState(this.kv, SERVER_KEY, next);
        return {
          state: next,
          deduped: false,
          conflictDeduped: result.outcome === "conflict_deduped",
        };
      },
      this.lock
    );
  }
}
