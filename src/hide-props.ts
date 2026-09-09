/**
 * 藏掉镜像下来的笔记顶上那一块「笔记属性」（frontmatter 面板）。
 *
 * 为什么不改 Obsidian 自己的全局设置（「属性显示方式」→ 隐藏）：那是**整个库**的开关，
 * 会把用户自己写的笔记的属性一起藏掉。镜像内容是机器生成的、属性里多半是流水线字段，
 * 用户自己的笔记不是 —— 所以只给镜像目录里的笔记挂一个 class，由 styles.css 按 class 藏。
 *
 * 只影响显示，不动文件一个字节。
 */
export const MIRROR_CLASS = "readonly-git-mirror-doc";

/** vault 相对路径（正斜杠）是否落在镜像目录内。targetDir 留空 = 整个库都是镜像。 */
export function inMirror(path: string, targetDir: string): boolean {
  const name = targetDir.trim();
  if (!name) return true;
  // 必须是「等于」或「以 name/ 开头」：只判 startsWith(name) 会把 kb-notes 也算进来。
  return path === name || path.startsWith(`${name}/`);
}
