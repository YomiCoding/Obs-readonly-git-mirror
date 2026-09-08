import { App, Notice, Plugin, PluginSettingTab, Setting } from "obsidian";
import { ConfigError, MirrorConfig, decodeConfig } from "./config";

export interface SettingsHost extends Plugin {
  cfg: MirrorConfig;
  state: { lastSyncAt: number; lastOid: string; lastError: string };
  saveAll(): Promise<void>;
  syncNow(): Promise<void>;
}

export class MirrorSettingTab extends PluginSettingTab {
  constructor(app: App, private host: SettingsHost) {
    super(app, host);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Setup code")
      .setDesc("Paste the one-line setup code from your administrator. It fills in everything below.")
      .addText((t) => {
        t.setPlaceholder("paste here");
        t.onChange(async (v) => {
          if (!v.trim()) return;
          try {
            this.host.cfg = decodeConfig(v);
            await this.host.saveAll();
            t.setValue("");
            new Notice("Setup code applied");
            this.display();
          } catch (e) {
            // 粘错了必须立刻知道。静默留在未配置状态就是「装了但不动」。
            new Notice(e instanceof ConfigError ? e.message : String(e), 8000);
          }
        });
      });

    const c = this.host.cfg;

    new Setting(containerEl).setName("Repository URL")
      .addText((t) => t.setValue(c.repoUrl).onChange(async (v) => {
        c.repoUrl = v.trim();
        await this.host.saveAll();
      }));

    new Setting(containerEl).setName("Username")
      .addText((t) => t.setValue(c.tokenUser).onChange(async (v) => {
        c.tokenUser = v.trim();
        await this.host.saveAll();
      }));

    new Setting(containerEl).setName("Token").setDesc("Read-only access token. It cannot push.")
      .addText((t) => {
        t.inputEl.type = "password";
        t.setValue(c.token).onChange(async (v) => {
          c.token = v.trim();
          await this.host.saveAll();
        });
      });

    const st = this.host.state;
    const when = st.lastSyncAt ? new Date(st.lastSyncAt).toLocaleString() : "never";
    new Setting(containerEl).setName("Last sync")
      .setDesc(st.lastError
        ? `Failed: ${st.lastError}`
        : `${when}${st.lastOid ? ` · ${st.lastOid.slice(0, 7)}` : ""}`)
      .addButton((b) => b.setButtonText("Sync now").onClick(async () => {
        await this.host.syncNow();
        this.display();
      }));

    containerEl.createEl("p", {
      text: "One-way and read-only. Files tracked by the remote repository are overwritten on every "
        + "sync; anything the repository does not track is never touched, so keep your own notes in "
        + "a folder the repository does not contain.",
      cls: "setting-item-description",
    });
  }
}
