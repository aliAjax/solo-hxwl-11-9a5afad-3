import { applyAction } from "./rules";
import { seedState } from "./seed";
import { KV, SETTINGS_KEY, SERVER_KEY, loadJSON, loadState, saveState, saveJSON } from "./storage";
import type { ReviewAction, ReviewState } from "./types";
import { ReviewError } from "./types";

export interface DispatchResult {
  state: ReviewState;
  deduped: boolean; // true = 重复 actionId，未再处理
}

/**
 * 模拟后端：自己持有权威状态并持久化（模拟服务端库）。
 * - 网络断开时任何请求都失败（NETWORK_OFFLINE），动作不入库
 * - actionId 在服务端去重，重复提交只生效一次
 * - 刷新页面后状态从持久化层恢复
 */
export class MockServer {
  private state: ReviewState;
  private kv: KV;
  online = true;
  latencyMs: number;

  constructor(kv: KV, opts: { latencyMs?: number } = {}) {
    this.kv = kv;
    this.latencyMs = opts.latencyMs ?? 120;
    const loaded = loadState(kv, SERVER_KEY);
    this.state = loaded ?? seedState();
    if (!loaded) saveState(kv, SERVER_KEY, this.state); // 服务端库初始化
    this.online = loadJSON<{ online: boolean }>(kv, SETTINGS_KEY)?.online ?? true;
  }

  getState(): ReviewState {
    return this.state;
  }

  setOnline(online: boolean): void {
    this.online = online;
    saveJSON(this.kv, SETTINGS_KEY, { online }); // 断网模拟状态跨刷新保持
  }

  reset(): ReviewState {
    this.state = seedState();
    this.online = true;
    saveState(this.kv, SERVER_KEY, this.state);
    saveJSON(this.kv, SETTINGS_KEY, { online: true });
    return this.state;
  }

  private delay(): Promise<void> {
    if (this.latencyMs <= 0) return Promise.resolve();
    return new Promise((resolve) => setTimeout(resolve, this.latencyMs));
  }

  async fetchState(): Promise<ReviewState> {
    await this.delay();
    if (!this.online) throw new ReviewError("NETWORK_OFFLINE", "网络已断开");
    return this.state;
  }

  async dispatch(action: ReviewAction): Promise<DispatchResult> {
    await this.delay();
    if (!this.online) throw new ReviewError("NETWORK_OFFLINE", "网络已断开，动作暂存本地");

    if (this.state.processedActions[action.actionId]) {
      return { state: this.state, deduped: true };
    }
    this.state = applyAction(this.state, action);
    saveState(this.kv, SERVER_KEY, this.state);
    return { state: this.state, deduped: false };
  }
}
