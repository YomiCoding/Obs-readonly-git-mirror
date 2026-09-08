export type MirrorConfig = {
  /** 远端仓库地址（https）。 */
  repoUrl: string;
  /** HTTP Basic 的用户名。 */
  tokenUser: string;
  /** HTTP Basic 的口令，通常是只读访问令牌。 */
  token: string;
  /** 仓库内下发隐藏名单的文件名。为空表示不使用。 */
  sparseFile: string;
  /** sparseFile 不存在时的兜底隐藏名单（顶层名）。 */
  hidePaths: string[];
};

export const DEFAULT_CONFIG: MirrorConfig = {
  repoUrl: "",
  tokenUser: "",
  token: "",
  sparseFile: ".mirror-sparse",
  hidePaths: [],
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
    sparseFile: p.sparseFile === undefined ? DEFAULT_CONFIG.sparseFile : String(p.sparseFile),
    hidePaths: Array.isArray(p.hidePaths) ? p.hidePaths.map(String) : [],
  };
}

/** 没配全就别发请求：省得每分钟朝空地址打一次，还把错误刷满状态栏。 */
export function isConfigured(c: MirrorConfig): boolean {
  return Boolean(c.repoUrl && c.token);
}
