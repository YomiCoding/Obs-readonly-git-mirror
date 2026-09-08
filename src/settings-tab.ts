import { App, Notice, Plugin, PluginSettingTab, SettingDefinitionItem } from "obsidian";
import { ConfigError, MirrorConfig, decodeConfig } from "./config";

export interface SettingsHost extends Plugin {
  cfg: MirrorConfig;
  state: { lastSyncAt: number; lastOid: string; lastError: string };
  saveAll(): Promise<void>;
  syncNow(): Promise<void>;
}

/** 设置项在存储里的键。声明式 API 用它来路由读写。 */
type Key = "setupCode" | "repoUrl" | "tokenUser" | "token";

/**
 * 用 1.13 的声明式设置 API（getSettingDefinitions / getControlValue /
 * setControlValue），而不是命令式的 display()。
 *
 * 理由不只是「新 API」：只有声明式的定义，Obsidian 才能把插件的设置项收进
 * **全局设置搜索**。用 display() 的话，1.13+ 的用户在设置里搜「mirror」「token」
 * 是搜不到我们的 —— 官方上架检查会直接就此告警。
 */
export class MirrorSettingTab extends PluginSettingTab {
  constructor(app: App, private host: SettingsHost) {
    super(app, host);
  }

  getSettingDefinitions(): SettingDefinitionItem[] {
    const st = this.host.state;
    const when = st.lastSyncAt ? new Date(st.lastSyncAt).toLocaleString() : "never";

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
    return this.host.cfg[key as Exclude<Key, "setupCode">] ?? "";
  }

  async setControlValue(key: string, value: unknown): Promise<void> {
    // 这几个控件全是 text 类型，值一定是字符串；显式收窄而不是 String(unknown)——
    // 后者对对象会静默变成 "[object Object]"，把垃圾写进配置。
    const v = typeof value === "string" ? value.trim() : "";

    if (key === "setupCode") {
      if (!v) return;
      try {
        this.host.cfg = decodeConfig(v);
        await this.host.saveAll();
        new Notice("Setup code applied");
        this.update();
      } catch (e) {
        // 粘错了必须立刻知道。静默留在未配置状态就是「装了但不动」。
        new Notice(e instanceof ConfigError ? e.message : String(e), 8000);
      }
      return;
    }

    this.host.cfg[key as Exclude<Key, "setupCode">] = v;
    await this.host.saveAll();
  }
}
