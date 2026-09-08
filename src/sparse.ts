/**
 * 仓库可以下发一份 git non-cone sparse-checkout 格式的隐藏名单：
 * `/*` 收全部，`!/x` 排除。isomorphic-git 没有 sparse-checkout，
 * 我们把它翻译成 checkout 的 filepaths（顶层白名单）。
 */
export function parseExcludes(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("!"))
    .map((l) => l.slice(1).replace(/^\//, "").replace(/\/$/, ""))
    .filter(Boolean);
}

/**
 * 顶层名全集减去排除项。
 * sparseText 为 null 表示仓库里没有名单文件，此时用调用方给的兜底名单。
 *
 * 名单不写死在插件里：写死的话，远端想增减隐藏项就得让每个用户升级插件。
 */
export function visiblePaths(
  allTopLevel: string[],
  sparseText: string | null,
  fallback: string[],
): string[] {
  const excluded = new Set(sparseText === null ? fallback : parseExcludes(sparseText));
  return allTopLevel.filter((p) => !excluded.has(p));
}
