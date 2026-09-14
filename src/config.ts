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
   * 读者在库里删掉受跟踪文件时，把删除上报到这个地址（POST JSON）。留空 = 不上报，
   * 删掉的文件下一轮照旧恢复（纯只读镜像）。服务端接受的删除不再恢复，直到远端也删掉它。
   */
  deleteReportUrl: string;
  /** 上报用的 Bearer 令牌。 */
  deleteReportToken: string;
  /** 写进审计记录的名字。留空时服务端只有操作系统登录名和机器名可记。 */
  reporterName: string;

  /** "git" = 只读镜像一个 Git 仓库；"inbox" = 从个人收件箱收取文件（见 inbox.ts）。 */
  mode: "git" | "inbox";
  /** inbox 模式：收件接口根地址。 */
  endpoint: string;
  /** inbox 模式：本设备的令牌（用配置码换来）。 */
  deviceToken: string;
  deviceId: string;
};

export const DEFAULT_CONFIG: MirrorConfig = {
  repoUrl: "",
  tokenUser: "",
  token: "",
  targetDir: "",
  sparseFile: "",   // 留空 → 自动探测，见 sync.ts 的 SPARSE_CANDIDATES
  hidePaths: [],
  deleteReportUrl: "",
  deleteReportToken: "",
  reporterName: "",
  mode: "git",
  endpoint: "",
  deviceToken: "",
  deviceId: "",
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
    deleteReportUrl: p.deleteReportUrl === undefined ? "" : String(p.deleteReportUrl),
    deleteReportToken: p.deleteReportToken === undefined ? "" : String(p.deleteReportToken),
    reporterName: p.reporterName === undefined ? "" : String(p.reporterName),
    mode: "git",
    endpoint: "",
    deviceToken: "",
    deviceId: "",
  };
}

/**
 * 配置码有两种：旧的 Git 镜像配置（一整份 MirrorConfig），和收件箱领取码 {v: 2, endpoint, claim}。
 * 后者只是一次性的领取码，插件拿它去换本设备的令牌，自己不保存它。
 */
export type SetupCode =
  | { kind: "git"; cfg: MirrorConfig }
  | { kind: "claim"; endpoint: string; claim: string };

export function decodeSetupCode(text: string): SetupCode {
  const raw = (text || "").trim();
  if (!raw) throw new ConfigError("配置码是空的");
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    throw new ConfigError("配置码格式不对，请重新索取");
  }
  if (parsed && typeof parsed === "object" && (parsed as { v?: unknown }).v === 2) {
    const p = parsed as { endpoint?: unknown; claim?: unknown };
    if (typeof p.endpoint !== "string" || !(p.endpoint.startsWith("https://") || p.endpoint.startsWith("http://"))) {
      throw new ConfigError("配置码里没有有效的服务地址");
    }
    if (typeof p.claim !== "string" || !p.claim) throw new ConfigError("配置码里没有领取码");
    return { kind: "claim", endpoint: p.endpoint, claim: p.claim };
  }
  return { kind: "git", cfg: decodeConfig(raw) };
}

/** 没配全就别发请求：省得每分钟朝空地址打一次，还把错误刷满状态栏。 */
export function isConfigured(c: MirrorConfig): boolean {
  if (c.mode === "inbox") return Boolean(c.endpoint && c.deviceToken);
  return Boolean(c.repoUrl && c.token);
}
