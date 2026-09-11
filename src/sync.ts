/**
 * 同步核心。
 *
 * ⚠ 本仓库里还有一份**独立实现**：`obsidian-plugin/src/sync.ts`（内部分发那条路径用）。
 * 两者刻意不共用代码——这一份的源码会公开，共用包意味着内部代码进入公开仓库的构建路径。
 * **在这里修了同步逻辑的 bug，要同步考虑那一份。** 反向的指路注释不加：那会改到
 * 另一个目录，违反「现有路径零改动」。
 */
import git from "isomorphic-git";
import { MirrorConfig } from "./config";
import { RequestUrlFn } from "./http";
import { visiblePaths } from "./sparse";

/**
 * 插件需要的 fs 能力，逐个精确声明。
 *
 * 不用 `any`：官方自动审核不允许禁用 `@typescript-eslint/no-explicit-any`，而一个
 * `any` 会顺着 fs 的每次调用扩散成几十条 no-unsafe-* 告警。
 *
 * 也不直接用 isomorphic-git 的 `PromiseFsClient`：它把每个方法都写成 `Function`，
 * 调用时同样躲不过 no-unsafe-call。
 *
 * 于是两边都满足：精确的函数类型天然可赋给 `Function`，所以这个类型既能通过
 * 类型检查传给 isomorphic-git，我们自己的调用又是有类型的。顺带把「这个插件到底
 * 碰文件系统的哪些能力」写成了白纸黑字 —— 对评估风险的审核者和用户都更有用。
 *
 * 前五个是我们自己调的；后三个我们不调，但 isomorphic-git 内部要用，
 * 结构上必须声明，否则赋值不兼容。
 */
export type MirrorFs = {
  promises: {
    readFile(path: string): Promise<Uint8Array>;
    stat(path: string): Promise<{ isDirectory(): boolean }>;
    readdir(path: string): Promise<string[]>;
    unlink(path: string): Promise<void>;
    rmdir(path: string): Promise<void>;

    writeFile(path: string, data: Uint8Array | string): Promise<void>;
    mkdir(path: string): Promise<void>;
    lstat(path: string): Promise<{ isDirectory(): boolean }>;
  };
};

type Fs = MirrorFs;

/**
 * isomorphic-git 只认 index（dircache）v2，读到别的版本直接抛
 * "Unsupported dircache version"。用户若曾用系统 git 的 sparse-checkout 操作过这个库，
 * skip-worktree 位会让 git 把 index 写成 v3。index 只是缓存，删掉让 checkout 重建；
 * 我们从不提交，丢掉暂存状态无害。
 */
async function ensureCompatibleIndex(fs: Fs, dir: string): Promise<void> {
  const path = `${dir}/.git/index`;
  let head: Uint8Array;
  try {
    head = await fs.promises.readFile(path);
  } catch {
    return; // 还没有 index，checkout 会自己建
  }
  if (head.length < 8) return;
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
  const sig = String.fromCharCode(
    view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3),
  );
  if (sig !== "DIRC") return;
  if (view.getUint32(4) !== 2) await fs.promises.unlink(path);
}

/** 递归列出某个顶层路径下的全部文件（相对 dir）。不存在时返回空。 */
async function walk(fs: Fs, dir: string, rel: string): Promise<string[]> {
  const out: string[] = [];
  const stack = [rel];
  while (stack.length) {
    const cur = stack.pop()!;
    let st;
    try {
      st = await fs.promises.stat(`${dir}/${cur}`);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      for (const name of await fs.promises.readdir(`${dir}/${cur}`)) stack.push(`${cur}/${name}`);
    } else {
      out.push(cur);
    }
  }
  return out;
}

/** 自底向上收掉空目录（含 rel 自身）。rel 是文件或不存在时什么都不做。 */
async function pruneEmptyDirs(fs: Fs, dir: string, rel: string): Promise<void> {
  let st;
  try {
    st = await fs.promises.stat(`${dir}/${rel}`);
  } catch {
    return;
  }
  if (!st.isDirectory()) return;
  for (const name of await fs.promises.readdir(`${dir}/${rel}`)) {
    await pruneEmptyDirs(fs, dir, `${rel}/${name}`);
  }
  if ((await fs.promises.readdir(`${dir}/${rel}`)).length === 0) {
    await fs.promises.rmdir(`${dir}/${rel}`);
  }
}

/**
 * 上一次同步落下的顶层项 —— 从本地 main 的树推导。没有 main（首次同步）时返回空。
 * 失败一律返回空：这只是用来扩大剪枝范围的补充信息，拿不到不该让整轮同步失败。
 */
async function previousTopLevels(fs: Fs, dir: string): Promise<string[]> {
  try {
    const prev = await git.resolveRef({ fs, dir, ref: "refs/heads/main" });
    const files = await git.listFiles({ fs, dir, ref: prev });
    return [...new Set(files.map((f) => f.split("/")[0]))];
  } catch {
    return [];
  }
}

async function readBlobText(fs: Fs, dir: string, oid: string, path: string): Promise<string | null> {
  try {
    const { blob } = await git.readBlob({ fs, dir, oid, filepath: path });
    return new TextDecoder().decode(blob);
  } catch {
    return null;
  }
}

/**
 * 配置里没指定名单文件时的默认名。
 *
 * 只有一个候选、且是中性名字：**不在这里硬编码任何具体部署方的文件名**。
 * 需要用别的名字的仓库，在设置里填、或由配置码带上即可。
 */
const DEFAULT_SPARSE_FILE = ".mirror-sparse";

async function readSparse(fs: Fs, dir: string, oid: string, name: string): Promise<string | null> {
  return readBlobText(fs, dir, oid, name || DEFAULT_SPARSE_FILE);
}

/**
 * 把工作区硬同步到 oid。返回实际落盘的顶层名。
 *
 * 服务端拥有的范围 = **git 树里出现过的顶层项**，不是一份写死的目录名单。
 * 未跟踪文件（用户自己的笔记）不在树里，因此任何一条路径都够不着它们 ——
 * 这让「不误删用户文件」成为结构性保证，而不是一条容易写漏的约定。
 * **绝不调 git.clean。**
 */
export async function applyRef(a: {
  fs: Fs; dir: string; oid: string; sparseFile: string; hidePaths: string[];
  /** 读者删掉、服务端已接受的文件：checkout 会把它们写回来，写回来之后再删掉。 */
  suppress?: string[];
}): Promise<string[]> {
  const { fs, dir, oid } = a;

  const sparse = await readSparse(fs, dir, oid, a.sparseFile);
  const files = await git.listFiles({ fs, dir, ref: oid });
  const allTop = [...new Set(files.map((f) => f.split("/")[0]))];
  const landed = visiblePaths(allTop, sparse, a.hidePaths);

  // 剪枝范围还要算上**上一次同步时** git 跟踪过的顶层项。否则远端把一整个顶层目录
  // 删空之后，它在新树里根本不出现，循环碰不到它，本地那批作废文件就永久留着。
  // 用上一个 HEAD 的树来推，不引入额外状态：服务端拥有的 = git 现在或曾经跟踪的。
  const prevTop = await previousTopLevels(fs, dir);
  const ownedTop = [...new Set([...allTop, ...prevTop])];

  await ensureCompatibleIndex(fs, dir);

  // checkout 的 ref 传裸 oid 会因为解析不到分支名而报错，借一个自己的 ref 当跳板。
  // **先 checkout 成功、再把 main 指过去**：反过来的话，checkout 失败时 main 已经
  // 前进，HEAD 与工作区就静默错位了。
  await git.writeRef({ fs, dir, ref: "refs/mirror/target", value: oid, force: true });
  await git.checkout({
    fs, dir, ref: "refs/mirror/target", filepaths: landed, force: true, noUpdateHead: true,
  });
  // 走到这里说明工作区已经就位。让 main 跟上 —— 不需要共同祖先，因此远端
  // force push 也能自愈。
  await git.writeRef({ fs, dir, ref: "refs/heads/main", value: oid, force: true });

  // 剪枝：树里没有、本地还在的文件要删掉。实测 isomorphic-git 的 checkout **不做**
  // 这件事，不显式剪枝的话作废文件会永久残留，而且没人会察觉。
  // 范围只在 allTop 之内 —— 未跟踪的顶层项一个都不碰。
  const want = new Set(files);
  const suppress = new Set(a.suppress ?? []);
  for (const top of ownedTop) {
    const keepTracked = landed.includes(top);
    for (const f of await walk(fs, dir, top)) {
      if (!keepTracked || !want.has(f) || suppress.has(f)) await fs.promises.unlink(`${dir}/${f}`);
    }
    await pruneEmptyDirs(fs, dir, top);
  }

  return landed;
}

async function exists(fs: Fs, path: string): Promise<boolean> {
  return fs.promises.stat(path).then(() => true).catch(() => false);
}

/**
 * 读者删掉的文件 = 上一轮同步落盘过（在本地 main 的树里、顶层项没被隐藏）、这一版远端仍然有、
 * 现在盘上却不见了的受跟踪文件。远端这一版已经删掉的不算——那是服务端的删除，不必上报。
 * 首次同步（没有本地 main）返回空。
 */
export async function detectLocalDeletions(a: {
  fs: Fs; dir: string; oid: string; sparseFile: string; hidePaths: string[];
}): Promise<string[]> {
  const { fs, dir, oid } = a;
  let prevFiles: string[];
  try {
    const prev = await git.resolveRef({ fs, dir, ref: "refs/heads/main" });
    prevFiles = await git.listFiles({ fs, dir, ref: prev });
  } catch {
    return [];
  }
  const sparse = await readSparse(fs, dir, oid, a.sparseFile);
  const files = await git.listFiles({ fs, dir, ref: oid });
  const allTop = [...new Set(files.map((f) => f.split("/")[0]))];
  const landed = new Set(visiblePaths(allTop, sparse, a.hidePaths));
  const inRemote = new Set(files);
  const out: string[] = [];
  for (const f of prevFiles) {
    if (!landed.has(f.split("/")[0]) || !inRemote.has(f)) continue;
    if (!(await exists(fs, `${dir}/${f}`))) out.push(f);
  }
  return out.sort();
}

export type Identity = { user: string; host: string };
/** 上报函数：路径 → 服务端接受的路径。抛错 = 这一轮没报上，文件照旧恢复。 */
export type ReportFn = (paths: string[]) => Promise<string[]>;

/**
 * 把删除 POST 给服务端。请求体 {paths, reporter, user, host}；响应 {accepted: [...]}。
 * 非 2xx 一律抛 SyncError（文案里不带令牌）。
 */
/** 上报请求的上限。requestUrl 自己没有超时：服务端滚动更新时一个被接住却永不回应的连接
 *  会让这一轮同步永远挂着，之后每分钟的同步都被「上一轮还没跑完」跳过——库就此静默停更。 */
export const REPORT_TIMEOUT_MS = 30_000;

export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new SyncError("network", `${what} timed out after ${Math.round(ms / 1000)}s`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e: unknown) => { clearTimeout(t); reject(e instanceof Error ? e : new Error(String(e))); });
  });
}

export async function reportDeletions(
  request: RequestUrlFn, cfg: MirrorConfig, paths: string[], identity: Identity, timeoutMs = REPORT_TIMEOUT_MS,
): Promise<string[]> {
  const body = new TextEncoder().encode(JSON.stringify({
    paths, reporter: cfg.reporterName, user: identity.user, host: identity.host,
  }));
  let res;
  try {
    res = await withTimeout(request({
      url: cfg.deleteReportUrl, method: "POST",
      headers: { Authorization: `Bearer ${cfg.deleteReportToken}`, "Content-Type": "application/json" },
      body: body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
      throw: false,
    }), timeoutMs, "deletion report");
  } catch (e) {
    if (e instanceof SyncError) throw e;          // 超时已经分好类了
    throw classify(e, cfg.deleteReportToken);
  }
  if (res.status < 200 || res.status >= 300) {
    throw new SyncError(res.status === 401 || res.status === 403 ? "auth" : "repo",
      `deletion report refused (HTTP ${res.status})`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(res.arrayBuffer));
  } catch {
    throw new SyncError("repo", "deletion report: server returned no JSON");
  }
  const accepted = (parsed as { accepted?: unknown }).accepted;
  return Array.isArray(accepted) ? accepted.filter((x): x is string => typeof x === "string") : [];
}

export type TreeResult = {
  landed: string[]; accepted: string[]; rejected: string[]; pending: string[]; reportError: string;
};

/**
 * 拉到 oid 之后的落盘：先看读者删了什么 → 新的删除上报 → 接受的这一轮不恢复并记进 pending
 * （之后每轮继续压住，直到远端树里也没有它）→ 其余照旧恢复。
 * report 为 null = 没配上报地址：删除一律恢复（纯只读镜像的老语义）。
 */
export async function syncTree(a: {
  fs: Fs; dir: string; oid: string; sparseFile: string; hidePaths: string[];
  pending: string[]; report: ReportFn | null;
}): Promise<TreeResult> {
  const { fs, dir, oid } = a;
  const inRemote = new Set(await git.listFiles({ fs, dir, ref: oid }));
  // 上一轮接受、远端还没删掉的：继续压住，不再上报
  const stillPending = a.pending.filter((p) => inRemote.has(p));
  const pendingSet = new Set(stillPending);
  const missing = await detectLocalDeletions(a);
  const fresh = missing.filter((p) => !pendingSet.has(p));
  let accepted: string[] = [];
  let reportError = "";
  if (fresh.length && a.report) {
    try {
      const got = new Set(await a.report(fresh));
      accepted = fresh.filter((p) => got.has(p));
    } catch (e) {
      reportError = e instanceof Error ? e.message : String(e);
    }
  }
  const acceptedSet = new Set(accepted);
  const rejected = fresh.filter((p) => !acceptedSet.has(p));
  const suppress = [...stillPending, ...accepted];
  const landed = await applyRef({ fs, dir, oid, sparseFile: a.sparseFile, hidePaths: a.hidePaths, suppress });
  return { landed, accepted, rejected, pending: suppress, reportError };
}

/**
 * Obsidian 新建库时自动生成的欢迎笔记（中文界面 欢迎.md，英文 Welcome.md）。
 * 推荐用法是「新建一个空库专门放镜像」，而新建的库一定带着这一篇；不把它当作空库的话，
 * 照着推荐做的每个用户都会被下面的保护拦住。
 */
const WELCOME_NOTES = new Set(["欢迎.md", "Welcome.md"]);

/**
 * 算出真正要镜像到哪个目录，必要时建出来。
 *
 * 这道保护是一次真实事故换来的：用户在**自己已有的笔记库**里装了插件
 * （Obsidian 启动时默认打开上次的库，很容易就这么发生），配好之后远端内容直接铺进
 * 个人库根目录，和自己的笔记混在一起 —— 全程没有一句提示。
 *
 * 所以：填了子文件夹就用它（在任何库里都安全）；留空要铺根目录时，只有「库是空的
 * （允许带 Obsidian 自带的欢迎笔记）」或者「本来就是我们在镜像的库」才放行。
 */
export async function resolveTarget(a: {
  fs: Fs; vaultPath: string; targetDir: string;
}): Promise<string> {
  const name = a.targetDir.trim();

  if (name) {
    // 只允许一层普通名字：带斜杠或上跳就能写到库外面去，那是另一回事，不该悄悄支持。
    if (name.includes("/") || name.includes("\\") || name === "." || name === "..") {
      throw new SyncError("repo",
        "Target folder must be a single folder name, without slashes.");
    }
    const dir = `${a.vaultPath}/${name}`;
    await a.fs.promises.mkdir(dir).catch(() => undefined);   // 已存在就算了
    return dir;
  }

  // 留空 = 铺在库根目录。先确认这么做不会把别人的笔记搅进来。
  const mirroring = await a.fs.promises.stat(`${a.vaultPath}/.git`)
    .then(() => true).catch(() => false);
  if (!mirroring) {
    const entries = (await a.fs.promises.readdir(a.vaultPath))
      .filter((n: string) => n !== ".obsidian" && !n.startsWith(".") && !WELCOME_NOTES.has(n));
    if (entries.length > 0) {
      // 把看到的东西点出来：用户往往不知道插件正跑在哪个库里（Obsidian 默认打开上次的库），
      // 光说「已有别的文件」他们会去删自己刚删过的文件夹，删来删去还是这条错。
      const seen = entries.slice(0, 3).join(", ") + (entries.length > 3 ? ", …" : "");
      throw new SyncError("repo",
        `This vault already contains other files (${seen}), so the mirror will not be written into its root. `
        + "Create a new, empty vault dedicated to the mirror and set the plugin up there (recommended), "
        + "or set a target subfolder in the settings so the mirror does not mix with your own notes.");
    }
  }
  return a.vaultPath;
}

export type SyncDeps = {
  fs: Fs; http: unknown; dir: string; cfg: MirrorConfig;
  /** 上一轮留下的、服务端已接受的删除。 */
  pending?: string[];
  /** 删除上报；null/缺省 = 不上报。 */
  report?: ReportFn | null;
};

export class SyncError extends Error {
  constructor(readonly kind: "auth" | "network" | "repo", message: string) {
    super(message);
    this.name = "SyncError";
  }
}

/** 令牌绝不能进错误文案 —— 错误会显示在设置页与通知上。 */
function scrub(text: string, token: string): string {
  return token ? text.split(token).join("***") : text;
}

function classify(e: unknown, token: string): SyncError {
  const raw = scrub(e instanceof Error ? e.message : String(e), token);
  if (/401|403|Unauthorized|Forbidden|auth/i.test(raw)) {
    return new SyncError("auth", "认证失败：访问令牌可能已过期");
  }
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|net::|network|fetch failed/i.test(raw)) {
    return new SyncError("network", "连不上服务器：请检查网络");
  }
  return new SyncError("repo", raw);
}

/** 拉取远端 main，返回它的 oid。浅克隆：单向只读镜像不需要历史。 */
export async function fetchRemote(d: SyncDeps): Promise<string> {
  try {
    const hasGit = await d.fs.promises.stat(`${d.dir}/.git`).then(() => true).catch(() => false);
    if (!hasGit) {
      await git.init({ fs: d.fs, dir: d.dir, defaultBranch: "main" });
      await git.addRemote({
        fs: d.fs, dir: d.dir, remote: "origin", url: d.cfg.repoUrl, force: true,
      });
    }
    const r = await git.fetch({
      fs: d.fs, http: d.http as never, dir: d.dir, url: d.cfg.repoUrl,
      ref: "main", singleBranch: true, depth: 1, tags: false,
      onAuth: () => ({ username: d.cfg.tokenUser, password: d.cfg.token }),
    });
    if (!r.fetchHead) throw new SyncError("repo", "远端没有返回 main 分支");
    await git.writeRef({
      fs: d.fs, dir: d.dir, ref: "refs/remotes/origin/main", value: r.fetchHead, force: true,
    });
    return r.fetchHead;
  } catch (e) {
    if (e instanceof SyncError) throw e;
    throw classify(e, d.cfg.token);
  }
}

/** 一轮同步：拉 + 落盘（含读者删除的上报与压制）。永不 commit、永不 push。 */
export async function syncOnce(d: SyncDeps): Promise<{ oid: string } & TreeResult> {
  const oid = await fetchRemote(d);
  const r = await syncTree({
    fs: d.fs, dir: d.dir, oid, sparseFile: d.cfg.sparseFile, hidePaths: d.cfg.hidePaths,
    pending: d.pending ?? [], report: d.report ?? null,
  });
  return { oid, ...r };
}
