import { Notice, Plugin, requestUrl } from "obsidian";
import { ConfigError, DEFAULT_CONFIG, MirrorConfig, decodeSetupCode, isConfigured } from "./config";
import { makeHttp } from "./http";
import { InboxError, InboxState, VaultIO, claimDevice, emptyInboxState, revokeDevice, syncInbox } from "./inbox";
import { MirrorSettingTab } from "./settings-tab";
import { statusText } from "./status";
import { TICK_MS, dueForScheduledSync } from "./schedule";
import { Identity, MirrorFs, SyncError, reportDeletions, resolveTarget, retireMirror, syncOnce } from "./sync";

/** 写死不给用户调：关掉自动同步不会有任何提示，只会慢慢变旧。节奏按模式分，见 schedule.ts。 */
/** 一轮同步超过这么久还没回来，就当它已经死掉：解锁，让下一轮照常跑。
 *  实测撞到过：服务端滚动更新期间一个请求永远不回应，之后 20 多分钟每一轮都被跳过，状态栏却毫无异常。 */
const STUCK_AFTER_MS = 5 * 60_000;

type State = {
  lastSyncAt: number; lastOid: string; lastError: string;
  /** 读者删掉、服务端已接受、远端还没删的文件：每轮继续压住，不让 checkout 写回来。 */
  pendingDeletes: string[];
  /** 每个压住的文件从何时开始（ms），压太久就放回来。 */
  pendingSince: Record<string, number>;
  /** inbox 模式的本地账本与待补发的确认。 */
  inbox: InboxState;
};

export default class GitMirrorPlugin extends Plugin {
  cfg: MirrorConfig = { ...DEFAULT_CONFIG };
  state: State = { lastSyncAt: 0, lastOid: "", lastError: "", pendingDeletes: [], pendingSince: {}, inbox: emptyInboxState() };
  private bar!: HTMLElement;
  private syncing = false;
  private syncStartedAt = 0;
  private lastAttemptAt = 0;

  async onload(): Promise<void> {
    const saved = ((await this.loadData()) ?? {}) as { cfg?: Partial<MirrorConfig>; state?: Partial<State> };
    this.cfg = { ...DEFAULT_CONFIG, ...(saved.cfg ?? {}) };
    this.state = { lastSyncAt: 0, lastOid: "", lastError: "", pendingDeletes: [], pendingSince: {}, inbox: emptyInboxState(), ...(saved.state ?? {}) };
    if (!Array.isArray(this.state.pendingDeletes)) this.state.pendingDeletes = [];
    if (!this.state.pendingSince || typeof this.state.pendingSince !== "object") this.state.pendingSince = {};
    if (!this.state.inbox || typeof this.state.inbox.ledger !== "object" || !Array.isArray(this.state.inbox.pendingAcks)) {
      this.state.inbox = emptyInboxState();
    }

    this.bar = this.addStatusBarItem();
    this.paint();

    this.addSettingTab(new MirrorSettingTab(this.app, this));
    this.addCommand({ id: "sync-now", name: "立即同步", callback: () => void this.syncNow() });
    this.addCommand({ id: "unlink-device", name: "解除本设备绑定（收件箱模式）", callback: () => void this.unlinkDevice() });

    // obsidian://readonly-git-mirror?config=<base64url>
    // 管理员发一条链接，用户点一下就配好，不用手打地址和令牌。
    this.registerObsidianProtocolHandler("readonly-git-mirror", async (params) => {
      const raw = params.config;
      if (!raw) return;
      await this.applySetupCode(String(raw));
    });

    this.app.workspace.onLayoutReady(() => void this.syncNow());
    this.registerInterval(window.setInterval(() => void this.tick(), TICK_MS));
  }

  async saveAll(): Promise<void> {
    await this.saveData({ cfg: this.cfg, state: this.state });
  }

  private paint(): void {
    this.bar.setText(statusText({ syncing: this.syncing, ...this.state, mode: this.cfg.mode }));
  }

  /** Setup codes come from the settings field or an obsidian:// link. Errors are shown, never swallowed. */
  async applySetupCode(raw: string): Promise<boolean> {
    try {
      const code = decodeSetupCode(raw);
      if (code.kind === "git") {
        this.cfg = code.cfg;
        await this.saveAll();
        new Notice("配置码已生效");
        void this.syncNow();
        return true;
      }
      const label = this.identity().host || "Obsidian";
      const { token, deviceId } = await claimDevice(requestUrl, code.endpoint, code.claim, label);
      const wasMirror = this.cfg.mode !== "inbox" && Boolean(this.cfg.repoUrl);
      this.cfg = { ...DEFAULT_CONFIG, mode: "inbox", endpoint: code.endpoint, deviceToken: token, deviceId, targetDir: this.cfg.targetDir };
      this.state.inbox = emptyInboxState();
      this.state.lastError = "";
      await this.saveAll();
      if (wasMirror) await this.retireOldMirror();
      new Notice("本设备已绑定，新内容会在下次同步时收到。");
      void this.syncNow();
      return true;
    } catch (e) {
      const msg = e instanceof ConfigError || e instanceof InboxError ? e.message : String(e instanceof Error ? e.message : e);
      new Notice(msg, 10_000);
      return false;
    }
  }

  private async retireOldMirror(): Promise<void> {
    try {
      const name = this.cfg.targetDir.trim();
      const dir = name ? `${this.vaultPath()}/${name}` : this.vaultPath();
      const r = await retireMirror(this.nodeFs(), dir);
      if (r.removed || r.kept) {
        new Notice(`已删除之前镜像里 ${r.removed} 个没改动过的文件；保留了 ${r.kept} 个你改过的文件。`, 10_000);
      }
    } catch (e) {
      new Notice(`没能清理之前的镜像：${e instanceof Error ? e.message : String(e)}`, 10_000);
    }
  }

  async unlinkDevice(): Promise<void> {
    if (this.cfg.mode !== "inbox") return;
    try {
      await revokeDevice(requestUrl, this.cfg.endpoint, this.cfg.deviceToken);
    } catch {
      // forget the token locally even when the server is unreachable; it can also be revoked from the server side
    }
    this.cfg = { ...DEFAULT_CONFIG, targetDir: this.cfg.targetDir };
    this.state.inbox = emptyInboxState();
    await this.saveAll();
    this.paint();
    new Notice("本设备已解除绑定，库里已有的文件会保留。");
  }

  /** The Obsidian vault adapter, shaped as what inbox mode needs. */
  private vaultIO(): VaultIO {
    const a = this.app.vault.adapter;
    return {
      exists: (p) => a.exists(p),
      read: async (p) => new Uint8Array(await a.readBinary(p)),
      write: (p, d) => a.writeBinary(p, d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength) as ArrayBuffer),
      rename: (from, to) => a.rename(from, to),
      mkdirp: async (p) => {
        let cur = "";
        for (const seg of p.split("/")) {
          cur = cur ? `${cur}/${seg}` : seg;
          if (!(await a.exists(cur))) await a.mkdir(cur);
        }
      },
    };
  }

  private async syncInboxRound(): Promise<void> {
    const name = this.cfg.targetDir.trim();
    if (name.includes("/") || name.includes(String.fromCharCode(92)) || name === "." || name === "..") {
      throw new SyncError("repo", "目标文件夹只能是一个文件夹名，不能带斜杠。");
    }
    const r = await syncInbox({
      req: requestUrl, endpoint: this.cfg.endpoint, token: this.cfg.deviceToken, io: this.vaultIO(), root: name,
      state: this.state.inbox,
      persist: async (s) => {
        this.state.inbox = s;
        await this.saveAll();
      },
    });
    if (r.failed) new Notice(`收件箱：${r.failed} 个条目没能保存，稍后会重试。`, 8000);
    this.state.lastOid = "";
  }

  /** vault 根目录的绝对路径。移动端的 adapter 没有 basePath，因此暂不支持。 */
  private vaultPath(): string {
    const p = (this.app.vault.adapter as unknown as { basePath?: string }).basePath;
    if (!p) throw new SyncError("repo", "暂不支持这个平台（仅支持桌面端）。");
    return p;
  }

  /**
   * Node 的 fs。只有桌面端的 Electron 渲染进程有 `window.require`；
   * 移动端没有，因此这里直接给出可读的失败原因，而不是让下游报一个看不懂的错。
   */
  private nodeFs(): MirrorFs {
    const req = (window as unknown as { require?: (m: string) => MirrorFs }).require;
    if (!req) throw new SyncError("repo", "暂不支持这个平台（仅支持桌面端）。");
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

  /** 定时器每 10 秒响一次；收件箱模式每次都同步，镜像模式仍是每分钟一次。 */
  private async tick(): Promise<void> {
    if (!dueForScheduledSync(this.cfg.mode, this.lastAttemptAt, Date.now())) return;
    await this.syncNow();
  }

  async syncNow(): Promise<void> {
    // 上一轮没跑完就跳过：定时器与手动同步可能撞车，两个 git 操作同动一个工作区会互相踩。
    // 但挂得太久的那一轮不能永远占着锁：视作已死，放行。
    if (this.syncing && Date.now() - this.syncStartedAt > STUCK_AFTER_MS) {
      this.syncing = false;
      new Notice("上一轮同步卡住了，已放弃，正在重新同步。", 8000);
    }
    if (this.syncing || !isConfigured(this.cfg)) return;
    this.syncing = true;
    this.syncStartedAt = Date.now();
    this.lastAttemptAt = this.syncStartedAt;
    this.paint();
    try {
      if (this.cfg.mode === "inbox") {
        await this.syncInboxRound();
        this.state.lastSyncAt = Date.now();
        this.state.lastError = "";
        return;
      }
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
        fs, http: makeHttp(requestUrl), dir, cfg, pending: this.state.pendingDeletes,
        pendingSince: this.state.pendingSince, report,
      });
      this.state.pendingDeletes = r.pending;
      this.state.pendingSince = r.pendingSince;
      if (r.expired.length) {
        new Notice(`已放回 ${r.expired.length} 个文件：服务端接受了删除，但一直没有删掉文件。如果仍要删除，请再删一次。`, 10_000);
      }
      // 删除的去向必须让人看见：被接受的会从服务端删掉，没被接受的已经被写回来了。
      if (r.accepted.length) new Notice(`已向服务端上报 ${r.accepted.length} 个删除的文件。`);
      if (r.rejected.length) {
        const why = r.reportError ? `（${r.reportError}）` : cfg.deleteReportUrl ? "（服务端没有接受）" : "（这个镜像是只读的）";
        new Notice(`已恢复你删除的 ${r.rejected.length} 个文件${why}。`, 10_000);
      }
      this.state.lastOid = r.oid;
      this.state.lastSyncAt = Date.now();
      this.state.lastError = "";
    } catch (e) {
      const msg = e instanceof SyncError || e instanceof InboxError ? e.message : String(e);
      // 只在从「好」变「坏」时弹一次：每分钟弹一次会把用户逼疯，
      // 而状态栏一直挂着失败，信息不会丢。
      if (!this.state.lastError) new Notice(`同步失败：${msg}`, 10_000);
      this.state.lastError = msg;
    } finally {
      this.syncing = false;
      await this.saveAll();
      this.paint();
    }
  }
}
