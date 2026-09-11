import { Notice, Plugin, requestUrl } from "obsidian";
import { DEFAULT_CONFIG, MirrorConfig, decodeConfig, isConfigured } from "./config";
import { makeHttp } from "./http";
import { MirrorSettingTab } from "./settings-tab";
import { statusText } from "./status";
import { Identity, MirrorFs, SyncError, reportDeletions, resolveTarget, syncOnce } from "./sync";

/** 写死不给用户调：关掉自动同步不会有任何提示，只会慢慢变旧。 */
const PULL_INTERVAL_MS = 60_000;
/** 一轮同步超过这么久还没回来，就当它已经死掉：解锁，让下一轮照常跑。
 *  实测撞到过：服务端滚动更新期间一个请求永远不回应，之后 20 多分钟每一轮都被跳过，状态栏却毫无异常。 */
const STUCK_AFTER_MS = 5 * 60_000;

type State = {
  lastSyncAt: number; lastOid: string; lastError: string;
  /** 读者删掉、服务端已接受、远端还没删的文件：每轮继续压住，不让 checkout 写回来。 */
  pendingDeletes: string[];
};

export default class GitMirrorPlugin extends Plugin {
  cfg: MirrorConfig = { ...DEFAULT_CONFIG };
  state: State = { lastSyncAt: 0, lastOid: "", lastError: "", pendingDeletes: [] };
  private bar!: HTMLElement;
  private syncing = false;
  private syncStartedAt = 0;

  async onload(): Promise<void> {
    const saved = ((await this.loadData()) ?? {}) as { cfg?: Partial<MirrorConfig>; state?: Partial<State> };
    this.cfg = { ...DEFAULT_CONFIG, ...(saved.cfg ?? {}) };
    this.state = { lastSyncAt: 0, lastOid: "", lastError: "", pendingDeletes: [], ...(saved.state ?? {}) };
    if (!Array.isArray(this.state.pendingDeletes)) this.state.pendingDeletes = [];

    this.bar = this.addStatusBarItem();
    this.paint();

    this.addSettingTab(new MirrorSettingTab(this.app, this));
    this.addCommand({ id: "sync-now", name: "Sync now", callback: () => void this.syncNow() });

    // obsidian://readonly-git-mirror?config=<base64url>
    // 管理员发一条链接，用户点一下就配好，不用手打地址和令牌。
    this.registerObsidianProtocolHandler("readonly-git-mirror", async (params) => {
      const raw = params.config;
      if (!raw) return;
      try {
        this.cfg = decodeConfig(String(raw));
        await this.saveAll();
        new Notice("Setup code applied");
        void this.syncNow();
      } catch (e) {
        new Notice(String(e instanceof Error ? e.message : e), 8000);
      }
    });

    this.app.workspace.onLayoutReady(() => void this.syncNow());
    this.registerInterval(window.setInterval(() => void this.syncNow(), PULL_INTERVAL_MS));
  }

  async saveAll(): Promise<void> {
    await this.saveData({ cfg: this.cfg, state: this.state });
  }

  private paint(): void {
    this.bar.setText(statusText({ syncing: this.syncing, ...this.state }));
  }

  /** vault 根目录的绝对路径。移动端的 adapter 没有 basePath，因此暂不支持。 */
  private vaultPath(): string {
    const p = (this.app.vault.adapter as unknown as { basePath?: string }).basePath;
    if (!p) throw new SyncError("repo", "This platform is not supported yet (desktop only).");
    return p;
  }

  /**
   * Node 的 fs。只有桌面端的 Electron 渲染进程有 `window.require`；
   * 移动端没有，因此这里直接给出可读的失败原因，而不是让下游报一个看不懂的错。
   */
  private nodeFs(): MirrorFs {
    const req = (window as unknown as { require?: (m: string) => MirrorFs }).require;
    if (!req) throw new SyncError("repo", "This platform is not supported yet (desktop only).");
    return req("fs");
  }

  /** 写进审计记录的机器身份：操作系统登录名与机器名。拿不到就留空，不因此中断同步。 */
  private identity(): Identity {
    try {
      const req = (window as unknown as { require?: (m: string) => { userInfo(): { username: string }; hostname(): string } }).require;
      const os = req?.("os");
      return { user: os?.userInfo().username ?? "", host: os?.hostname() ?? "" };
    } catch {
      return { user: "", host: "" };
    }
  }

  async syncNow(): Promise<void> {
    // 上一轮没跑完就跳过：定时器与手动同步可能撞车，两个 git 操作同动一个工作区会互相踩。
    // 但挂得太久的那一轮不能永远占着锁：视作已死，放行。
    if (this.syncing && Date.now() - this.syncStartedAt > STUCK_AFTER_MS) {
      this.syncing = false;
      new Notice("Mirror: previous sync hung and was abandoned; syncing again.", 8000);
    }
    if (this.syncing || !isConfigured(this.cfg)) return;
    this.syncing = true;
    this.syncStartedAt = Date.now();
    this.paint();
    try {
      const fs = this.nodeFs();
      // 镜像到哪个目录由配置决定，并在这一步拦住「铺进别人已有的笔记库」。
      const dir = await resolveTarget({
        fs, vaultPath: this.vaultPath(), targetDir: this.cfg.targetDir,
      });
      const cfg = this.cfg;
      const report = cfg.deleteReportUrl
        ? (paths: string[]) => reportDeletions(requestUrl, cfg, paths, this.identity())
        : null;
      const r = await syncOnce({
        fs, http: makeHttp(requestUrl), dir, cfg, pending: this.state.pendingDeletes, report,
      });
      this.state.pendingDeletes = r.pending;
      // 删除的去向必须让人看见：被接受的会从服务端删掉，没被接受的已经被写回来了。
      if (r.accepted.length) new Notice(`Reported ${r.accepted.length} deleted file(s) to the server.`);
      if (r.rejected.length) {
        const why = r.reportError ? ` (${r.reportError})` : cfg.deleteReportUrl ? " (not accepted by the server)" : " (this mirror is read-only)";
        new Notice(`Restored ${r.rejected.length} file(s) you deleted${why}.`, 10_000);
      }
      this.state.lastOid = r.oid;
      this.state.lastSyncAt = Date.now();
      this.state.lastError = "";
    } catch (e) {
      const msg = e instanceof SyncError ? e.message : String(e);
      // 只在从「好」变「坏」时弹一次：每分钟弹一次会把用户逼疯，
      // 而状态栏一直挂着失败，信息不会丢。
      if (!this.state.lastError) new Notice(`Mirror sync failed: ${msg}`, 10_000);
      this.state.lastError = msg;
    } finally {
      this.syncing = false;
      await this.saveAll();
      this.paint();
    }
  }
}
