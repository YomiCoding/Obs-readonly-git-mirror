function hhmm(t: number): string {
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/**
 * 状态栏文案。失败必须显式说 failed —— 静默是这类同步工具最坏的失败模式：
 * 用户只会觉得「怎么好久没新内容」。
 *
 * 失败优先于「上次成功时刻」：上次成功过不代表现在是好的。令牌昨天过期、状态栏
 * 还挂着昨天的时间戳，用户会以为一切正常。
 */
export function statusText(s: {
  syncing: boolean; lastSyncAt: number; lastError: string;
}): string {
  if (s.syncing) return "Mirror: syncing…";
  if (s.lastError) return `Mirror: failed · ${s.lastError}`;
  if (!s.lastSyncAt) return "Mirror: not synced yet";
  return `Mirror: synced ${hhmm(s.lastSyncAt)}`;
}
