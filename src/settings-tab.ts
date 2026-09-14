import { App, Plugin, PluginSettingTab, SettingDefinitionItem } from "obsidian";
import { MirrorConfig } from "./config";
import { SetupCodeGate } from "./setup-gate";

export interface SettingsHost extends Plugin {
  cfg: MirrorConfig;
  state: { lastSyncAt: number; lastOid: string; lastError: string };
  saveAll(): Promise<void>;
  syncNow(): Promise<void>;
  applySetupCode(raw: string): Promise<boolean>;
  unlinkDevice(): Promise<void>;
}

/** 设置项在存储里的键。声明式 API 用它来路由读写。 */
type Key = "setupCode" | "repoUrl" | "tokenUser" | "token" | "targetDir" | "sparseFile"
  | "deleteReportUrl" | "deleteReportToken" | "reporterName";

/**
 * 用 1.13 的声明式设置 API（getSettingDefinitions / getControlValue /
 * setControlValue），而不是命令式的 display()。
 *
 * 理由不只是「新 API」：只有声明式的定义，Obsidian 才能把插件的设置项收进
 * **全局设置搜索**。用 display() 的话，1.13+ 的用户在设置里搜「mirror」「token」
 * 是搜不到我们的 —— 官方上架检查会直接就此告警。
 *
 * 代价是 `minAppVersion` 必须是 1.13.0：这套 API（含 `update()`）1.13 才有。
 * 权衡过「同时实现 display() 兼容旧版」，没做 —— 那要为两套渲染路径付双份代码和
 * 双份出错面，而换来的是一个几乎不存在的用户群（Obsidian 自动更新，1.13 已是现行版）。
 */
export class MirrorSettingTab extends PluginSettingTab {
  private setupGate = new SetupCodeGate();

  constructor(app: App, private host: SettingsHost) {
    super(app, host);
  }

  getSettingDefinitions(): SettingDefinitionItem[] {
    const st = this.host.state;
    const when = st.lastSyncAt ? new Date(st.lastSyncAt).toLocaleString() : "never";

    if (this.host.cfg.mode === "inbox") {
      let server = this.host.cfg.endpoint;
      try {
        server = new URL(server).host;
      } catch {
        // keep the raw value
      }
      return [
        {
          name: "Setup code",
          desc: "Paste a new setup code to link this device again or to switch servers.",
          aliases: ["config", "token", "link"],
          control: { type: "text", key: "setupCode", placeholder: "paste here" },
        },
        {
          name: "Target folder",
          desc: "Leave empty to write into the vault root (recommended: a vault dedicated to this). "
            + "Set a single folder name, no slashes, to keep received files in one folder.",
          aliases: ["folder", "directory", "location"],
          control: { type: "text", key: "targetDir", placeholder: "inbox" },
        },
        { name: "Server", desc: `Receiving from ${server}.` },
        {
          name: "Last sync",
          desc: st.lastError ? `Failed: ${st.lastError}` : when,
          action: () => {
            void this.host.syncNow().then(() => this.update());
          },
        },
        {
          name: "Unlink this device",
          desc: "Stops receiving on this device. Files already in the vault stay.",
          action: () => {
            void this.host.unlinkDevice().then(() => this.update());
          },
        },
        {
          name: "How it works",
          desc: "Inbox mode only adds files: it never deletes a file and never overwrites a file it did not write. "
            + "After a file has been saved and verified here, the server deletes its own copy after a grace period, "
            + "so this vault holds the only copy. Deleting a file here is final.",
        },
      ];
    }

    return [
      {
        name: "Setup code",
        desc: "Paste the one-line setup code from your administrator. It fills in everything below.",
        aliases: ["config", "token", "repository"],
        control: { type: "text", key: "setupCode", placeholder: "paste here" },
      },
      {
        name: "Repository URL",
        desc: "HTTPS address of the Git repository to mirror.",
        control: { type: "text", key: "repoUrl", placeholder: "https://example.com/team/handbook.git" },
      },
      {
        name: "Username",
        desc: "User name sent with the access token.",
        control: { type: "text", key: "tokenUser" },
      },
      {
        name: "Token",
        desc: "Read-only access token. It cannot push.",
        control: { type: "text", key: "token" },
      },
      {
        name: "Target folder",
        desc: "Leave empty when this vault is dedicated to the mirror (recommended: create a new, "
          + "empty vault for it, and switch vaults with the vault switcher). Set a single folder "
          + "name, no slashes, only if you want the mirror inside a vault that also holds your own notes.",
        aliases: ["folder", "directory", "location"],
        control: { type: "text", key: "targetDir", placeholder: "knowledge-base" },
      },
      {
        name: "Hidden paths file",
        desc: "Optional. Name of a file in the repository listing top-level paths to keep "
          + "out of the vault, in Git non-cone sparse-checkout format. Leave empty to mirror "
          + "everything.",
        aliases: ["sparse", "exclude", "ignore"],
        control: { type: "text", key: "sparseFile", placeholder: ".mirror-sparse" },
      },
      {
        name: "Deletion report URL",
        desc: "Optional. When you delete a mirrored file, the plugin reports it here (HTTP POST) "
          + "instead of restoring it; the server decides whether the deletion sticks. Leave empty "
          + "for a purely read-only mirror where deleted files come back on the next sync.",
        aliases: ["delete", "webhook", "report"],
        control: { type: "text", key: "deleteReportUrl", placeholder: "https://example.com/api/vault/deletions" },
      },
      {
        name: "Deletion report token",
        desc: "Bearer token sent with deletion reports.",
        control: { type: "text", key: "deleteReportToken" },
      },
      {
        name: "Your name",
        desc: "Recorded in the server's audit trail next to your OS user name and machine name.",
        aliases: ["audit", "reporter"],
        control: { type: "text", key: "reporterName", placeholder: "e.g. Zhang San" },
      },
      {
        name: "Last sync",
        desc: st.lastError
          ? `Failed: ${st.lastError}`
          : `${when}${st.lastOid ? ` · ${st.lastOid.slice(0, 7)}` : ""}`,
        action: () => {
          void this.host.syncNow().then(() => this.update());
        },
      },
      {
        name: "How it works",
        desc: "One-way and read-only. Files tracked by the remote repository are overwritten on "
          + "every sync; anything the repository does not track is never touched, so keep your own "
          + "notes in a folder the repository does not contain.",
      },
    ];
  }

  getControlValue(key: string): unknown {
    // 配置码是一次性输入，不回显：它含令牌，留在输入框里等于把凭据摆在设置页上。
    if (key === "setupCode") return "";
    return (this.host.cfg as Record<Exclude<Key, "setupCode">, string>)[key as Exclude<Key, "setupCode">] ?? "";
  }

  async setControlValue(key: string, value: unknown): Promise<void> {
    // 这几个控件全是 text 类型，值一定是字符串；显式收窄而不是 String(unknown)——
    // 后者对对象会静默变成 "[object Object]"，把垃圾写进配置。
    const v = typeof value === "string" ? value.trim() : "";

    if (key === "setupCode") {
      // 同一个码失焦时会再报一次：一次性码第二次提交必被拒，刚绑定成功就弹报错。只有成功用过的才拦。
      if (!this.setupGate.shouldApply(v)) return;
      // 粘错了必须立刻知道：applySetupCode 自己弹出原因。静默留在未配置状态就是「装了但不动」。
      if (await this.host.applySetupCode(v)) this.setupGate.applied(v);
      this.update();
      return;
    }

    (this.host.cfg as Record<Exclude<Key, "setupCode">, string>)[key as Exclude<Key, "setupCode">] = v;
    await this.host.saveAll();
  }
}
