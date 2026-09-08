import { Notice, Plugin, requestUrl } from "obsidian";
import { DEFAULT_CONFIG, MirrorConfig, decodeConfig, isConfigured } from "./config";
import { makeHttp } from "./http";
import { MirrorSettingTab } from "./settings-tab";
import { statusText } from "./status";
import { MirrorFs, SyncError, syncOnce } from "./sync";

/** 写死不给用户调：关掉自动同步不会有任何提示，只会慢慢变旧。 */
const PULL_INTERVAL_MS = 60_000;

type State = { lastSyncAt: number; lastOid: string; lastError: string };

export default class GitMirrorPlugin extends Plugin {
  cfg: MirrorConfig = { ...DEFAULT_CONFIG };
  state: State = { lastSyncAt: 0, lastOid: "", lastError: "" };
  private bar!: HTMLElement;
  private syncing = false;

  async onload(): Promise<void> {
    const saved = ((await this.loadData()) ?? {}) as { cfg?: Partial<MirrorConfig>; state?: Partial<State> };
    this.cfg = { ...DEFAULT_CONFIG, ...(saved.cfg ?? {}) };
    this.state = { lastSyncAt: 0, lastOid: "", lastError: "", ...(saved.state ?? {}) };

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

  async syncNow(): Promise<void> {
    // 上一轮没跑完就跳过：定时器与手动同步可能撞车，两个 git 操作同动一个工作区会互相踩。
    if (this.syncing || !isConfigured(this.cfg)) return;
    this.syncing = true;
    this.paint();
    try {
      const { oid } = await syncOnce({
        fs: this.nodeFs(),
        http: makeHttp(requestUrl),
        dir: this.vaultPath(),
        cfg: this.cfg,
      });
      this.state.lastOid = oid;
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
