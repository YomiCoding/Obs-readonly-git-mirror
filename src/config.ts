export type MirrorConfig = {
  /** 远端仓库地址（https）。 */
  repoUrl: string;
  /** HTTP Basic 的用户名。 */
  tokenUser: string;
  /** HTTP Basic 的口令，通常是只读访问令牌。 */
  token: string;
  /**
   * 镜像到库里的哪个子文件夹。**留空 = 直接铺在库根目录**。
   *
   * 强烈建议填一个：铺在根目录会把远端内容和用户自己的笔记混在一起，
   * 而用户往往是在自己已有的笔记库里装的插件（Obsidian 启动时默认打开上次的库）。
   * 留空时会有一道保护，见 sync.ts 的 assertSafeTarget。
   */
  targetDir: string;

  /**
   * 仓库内下发隐藏名单的文件名。
   * 留空 = 自动探测几个常见名字；填了就只认填的那个。
   */
  sparseFile: string;
  /** sparseFile 不存在时的兜底隐藏名单（顶层名）。 */
  hidePaths: string[];

  /**
   * 藏掉镜像下来的笔记顶上那一块「笔记属性」（frontmatter 面板）。
   *
   * 默认开：镜像内容多半是机器生成的，属性里是流水线字段，对读者是噪音。
   * 只影响显示，不改文件；镜像的是人手写的资料库（属性里有 aliases/cssclasses
   * 这类真有用的东西）就关掉它。**只作用于镜像目录，用户自己的笔记不受影响。**
   */
  hideProps: boolean;
};

export const DEFAULT_CONFIG: MirrorConfig = {
  repoUrl: "",
  tokenUser: "",
  token: "",
  targetDir: "",
  sparseFile: "",   // 留空 → 自动探测，见 sync.ts 的 SPARSE_CANDIDATES
  hidePaths: [],
  hideProps: true,
};

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/** 配置 → 一行 base64url。用 base64url 而不是 base64：后者含 + / =，放进 URL 要转义。 */
export function encodeConfig(c: MirrorConfig): string {
  return Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
}

/**
 * 一行 base64url → 配置。任何一步失败都抛出**可读**的 ConfigError：
 * 用户粘错了东西必须立刻知道，静默留在未配置状态就是「装了但不动」——
 * 那正是这类同步工具最坏的失败模式。
 */
export function decodeConfig(text: string): MirrorConfig {
  const raw = (text || "").trim();
  if (!raw) throw new ConfigError("配置码是空的");

  let json: string;
  try {
    json = Buffer.from(raw, "base64url").toString("utf8");
  } catch {
    throw new ConfigError("配置码格式不对，请向管理员重新索取");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new ConfigError("配置码格式不对，请向管理员重新索取");
  }
  if (!parsed || typeof parsed !== "object") {
    throw new ConfigError("配置码格式不对，请向管理员重新索取");
  }

  const p = parsed as Partial<MirrorConfig>;
  if (!p.repoUrl) throw new ConfigError("配置码里没有仓库地址");
  if (!p.token) throw new ConfigError("配置码里没有访问令牌");

  return {
    repoUrl: String(p.repoUrl),
    tokenUser: String(p.tokenUser ?? ""),
    token: String(p.token),
    targetDir: p.targetDir === undefined ? DEFAULT_CONFIG.targetDir : String(p.targetDir),
    sparseFile: p.sparseFile === undefined ? DEFAULT_CONFIG.sparseFile : String(p.sparseFile),
    hidePaths: Array.isArray(p.hidePaths) ? p.hidePaths.map(String) : [],
    // 老配置码里没有这个字段，必须落到默认值 —— 用 Boolean(undefined) 会静默变成 false。
    hideProps: typeof p.hideProps === "boolean" ? p.hideProps : DEFAULT_CONFIG.hideProps,
  };
}

/** 没配全就别发请求：省得每分钟朝空地址打一次，还把错误刷满状态栏。 */
export function isConfigured(c: MirrorConfig): boolean {
  return Boolean(c.repoUrl && c.token);
}
