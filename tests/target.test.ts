import fs from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SyncError, resolveTarget } from "../src/sync";

let vault: string;
beforeEach(async () => { vault = await mkdtemp(join(tmpdir(), "vault-")); });
afterEach(async () => { await rm(vault, { recursive: true, force: true }); });

describe("resolveTarget", () => {
  it("填了子文件夹 → 用它，并自动建出来", async () => {
    await writeFile(join(vault, "我的笔记.md"), "x");   // 库里本来就有东西也没关系
    const t = await resolveTarget({ fs, vaultPath: vault, targetDir: "知识库" });
    expect(t).toBe(join(vault, "知识库"));
    expect(existsSync(t)).toBe(true);
  });

  it("留空 + 空库 → 铺在根目录，允许", async () => {
    await mkdir(join(vault, ".obsidian"), { recursive: true });
    const t = await resolveTarget({ fs, vaultPath: vault, targetDir: "" });
    expect(t).toBe(vault);
  });

  it("留空 + 只有 Obsidian 新建库自带的欢迎笔记 → 当作空库放行", async () => {
    // 「新建一个空库专门放镜像」是推荐用法，而 Obsidian 新建库时一定会生成一篇欢迎笔记
    // （中文界面叫 欢迎.md，英文叫 Welcome.md）。不放行的话，照着推荐做的每个用户都会被拦。
    await mkdir(join(vault, ".obsidian"), { recursive: true });
    await writeFile(join(vault, "欢迎.md"), "这是你的新*仓库*。");
    expect(await resolveTarget({ fs, vaultPath: vault, targetDir: "" })).toBe(vault);
    await rm(join(vault, "欢迎.md"));
    await writeFile(join(vault, "Welcome.md"), "This is your new *vault*.");
    expect(await resolveTarget({ fs, vaultPath: vault, targetDir: "" })).toBe(vault);
  });

  it("留空 + 库里已有用户文件 → 拒绝，且说清怎么办", async () => {
    await mkdir(join(vault, ".obsidian"), { recursive: true });
    await writeFile(join(vault, "我的想法.md"), "我的笔记");

    // 这是真实事故：用户在自己已有的笔记库里装了插件（Obsidian 启动默认打开上次的库），
    // 结果远端内容被灌进个人库，和自己的笔记混在一起，全程没有一句提示。
    await expect(resolveTarget({ fs, vaultPath: vault, targetDir: "" }))
      .rejects.toThrow(SyncError);
    await expect(resolveTarget({ fs, vaultPath: vault, targetDir: "" }))
      .rejects.toThrow(/子文件夹|subfolder/);
  });

  it("留空 + 之前已经在这里镜像过 → 继续允许，不因为自己拉下来的内容把自己拦住", async () => {
    await mkdir(join(vault, ".obsidian"), { recursive: true });
    await mkdir(join(vault, ".git"), { recursive: true });   // 上一轮镜像留下的
    await writeFile(join(vault, "docs.md"), "远端拉下来的");
    const t = await resolveTarget({ fs, vaultPath: vault, targetDir: "" });
    expect(t).toBe(vault);
  });

  it("子文件夹名里的斜杠与上跳会被拒绝 —— 不能写到库外面去", async () => {
    for (const bad of ["../外面", "a/b", "/绝对路径"]) {
      await expect(resolveTarget({ fs, vaultPath: vault, targetDir: bad }))
        .rejects.toThrow(SyncError);
    }
  });
});
