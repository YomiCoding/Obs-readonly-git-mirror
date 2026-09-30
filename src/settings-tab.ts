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
 * **全局设置搜索**。用 display() 的话，1.13+ 的用户在设置里搜「配置码」「token」
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
    const when = st.lastSyncAt ? new Date(st.lastSyncAt).toLocaleString() : "从未同步";

    if (this.host.cfg.mode === "inbox") {
      let server = this.host.cfg.endpoint;
      try {
        server = new URL(server).host;
      } catch {
        // keep the raw value
      }
      return [
        {
          name: "配置码",
          desc: "粘贴新的配置码，可以重新绑定本设备，或者切换服务器。",
          aliases: ["配置", "绑定", "setup code", "config", "token", "link"],
          control: { type: "text", key: "setupCode", placeholder: "粘贴到这里" },
        },
        {
          name: "目标文件夹",
          desc: "留空则写进库的根目录（推荐：专门用一个库来接收）。"
            + "填一个文件夹名（不带斜杠），收到的文件都会放进这个文件夹。",
          aliases: ["文件夹", "目录", "位置", "folder", "directory", "location"],
          control: { type: "text", key: "targetDir", placeholder: "收件箱" },
        },
        { name: "服务器", desc: `正在从 ${server} 接收。` },
        {
          name: "上次同步",
          desc: st.lastError ? `失败：${st.lastError}` : when,
          action: () => {
            void this.host.syncNow().then(() => this.update());
          },
        },
        {
          name: "解除本设备绑定",
          desc: "本设备停止接收。库里已有的文件会保留。",
          action: () => {
            void this.host.unlinkDevice().then(() => this.update());
          },
        },
        {
          name: "工作方式",
          desc: "收件箱模式只新增文件：从不删除文件，也从不覆盖不是它写入的文件。"
            + "文件在这里保存并校验之后，服务端会在一段宽限期后删除自己的那一份，"
            + "所以这个库里的就是唯一的一份。在这里删除文件就是永久删除。",
        },
      ];
    }

    return [
      {
        name: "配置码",
        desc: "粘贴管理员给你的一行配置码，下面各项会自动填好。",
        aliases: ["配置", "setup code", "config", "token", "repository"],
        control: { type: "text", key: "setupCode", placeholder: "粘贴到这里" },
      },
      {
        name: "仓库地址",
        desc: "要镜像的 Git 仓库的 HTTPS 地址。",
        aliases: ["repository", "url"],
        control: { type: "text", key: "repoUrl", placeholder: "https://example.com/team/handbook.git" },
      },
      {
        name: "用户名",
        desc: "和访问令牌一起发送的用户名。",
        aliases: ["username"],
        control: { type: "text", key: "tokenUser" },
      },
      {
        name: "访问令牌",
        desc: "只读访问令牌，不能推送。",
        aliases: ["token"],
        control: { type: "text", key: "token" },
      },
      {
        name: "目标文件夹",
        desc: "这个库专门用来放镜像时留空（推荐：为镜像新建一个空库，用库切换器切换）。"
          + "只有想把镜像放进一个也存放你自己笔记的库时，才填一个文件夹名（不带斜杠）。",
        aliases: ["文件夹", "目录", "位置", "folder", "directory", "location"],
        control: { type: "text", key: "targetDir", placeholder: "knowledge-base" },
      },
      {
        name: "隐藏路径文件",
        desc: "可选。仓库里一个文件的名字，文件中列出不放进库的顶层路径，"
          + "格式为 Git non-cone sparse-checkout。留空则镜像全部内容。",
        aliases: ["隐藏", "排除", "sparse", "exclude", "ignore"],
        control: { type: "text", key: "sparseFile", placeholder: ".mirror-sparse" },
      },
      {
        name: "删除上报地址",
        desc: "可选。你删除镜像文件时，插件把它上报到这里（HTTP POST），而不是把文件放回来；"
          + "删除是否生效由服务端决定。留空则为纯只读镜像，删掉的文件下次同步会回来。",
        aliases: ["删除", "上报", "delete", "webhook", "report"],
        control: { type: "text", key: "deleteReportUrl", placeholder: "https://example.com/api/vault/deletions" },
      },
      {
        name: "删除上报令牌",
        desc: "删除上报时附带的 Bearer 令牌。",
        control: { type: "text", key: "deleteReportToken" },
      },
      {
        name: "你的名字",
        desc: "和你的操作系统登录名、机器名一起记进服务端的审计记录。",
        aliases: ["审计", "姓名", "audit", "reporter"],
        control: { type: "text", key: "reporterName", placeholder: "例如：张三" },
      },
      {
        name: "上次同步",
        desc: st.lastError
          ? `失败：${st.lastError}`
          : `${when}${st.lastOid ? ` · ${st.lastOid.slice(0, 7)}` : ""}`,
        action: () => {
          void this.host.syncNow().then(() => this.update());
        },
      },
      {
        name: "工作方式",
        desc: "单向、只读。远端仓库跟踪的文件每次同步都会被覆盖；仓库没有跟踪的文件从不改动，"
          + "所以请把自己的笔记放在仓库里没有的文件夹中。",
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
