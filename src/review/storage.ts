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

export function loadState(kv: KV, key: string): ReviewState | null {
  const raw = kv.getItem(key);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as ReviewState;
    if (parsed.version !== 1 || !Array.isArray(parsed.items)) return null;
    return parsed;
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

/** 测试/重置用的内存 KV */
export function memoryKV(initial: Record<string, string> = {}): KV {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => (map.has(k) ? map.get(k)! : null),
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}
