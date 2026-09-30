function hhmm(t: number): string {
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/**
 * 状态栏文案。失败必须显式说「同步失败」 —— 静默是这类同步工具最坏的失败模式：
 * 用户只会觉得「怎么好久没新内容」。
 *
 * 失败优先于「上次成功时刻」：上次成功过不代表现在是好的。令牌昨天过期、状态栏
 * 还挂着昨天的时间戳，用户会以为一切正常。
 */
export function statusText(s: {
  syncing: boolean; lastSyncAt: number; lastError: string; mode?: "git" | "inbox";
  /** 收件箱模式下的共享库镜像；它失败时单独说，不把收件箱那一半也说成失败。 */
  shared?: { active: boolean; entries: number; error: string };
}): string {
  const label = s.mode === "inbox" ? "收件箱" : "镜像";
  if (s.syncing) return `${label}：正在同步…`;
  if (s.lastError) return `${label}：同步失败 · ${s.lastError}`;
  if (!s.lastSyncAt) return `${label}：尚未同步`;
  const sh = s.mode === "inbox" ? s.shared : undefined;
  const tail = sh?.error ? ` · 共享库同步失败（${sh.error}）` : sh?.active ? ` · 共享库 ${sh.entries} 条` : "";
  return `${label}：已同步 ${hhmm(s.lastSyncAt)}${tail}`;
}
