import { existsSync } from "node:fs";
import fs from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import git from "isomorphic-git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyRef } from "../src/sync";

let dir: string;

async function put(rel: string, content: string) {
  const p = join(dir, rel);
  await mkdir(join(p, ".."), { recursive: true });
  await writeFile(p, content);
  await git.add({ fs, dir, filepath: rel });
}

/**
 * 模拟「服务端推了一版」。
 *
 * git.commit 会顺手推进当前分支，但在真实运行里 refs/heads/main **只应该由 applyRef
 * 推进** —— 它代表「本地已经同步到哪」。所以提交后把 main 拨回原处，只让
 * refs/remotes/origin/main 前进。不这么做的话，「上一次同步到哪」就永远等于
 * 「这一次要同步到哪」，依赖它的剪枝逻辑就测不出来。
 */
async function commitAsRemote(message: string): Promise<string> {
  const before = await git.resolveRef({ fs, dir, ref: "refs/heads/main" }).catch(() => null);
  const oid = await git.commit({
    fs, dir, message, author: { name: "server", email: "s@local" },
  });
  if (before) await git.writeRef({ fs, dir, ref: "refs/heads/main", value: before, force: true });
  await git.writeRef({ fs, dir, ref: "refs/remotes/origin/main", value: oid, force: true });
  return oid;
}

const OPTS = { sparseFile: ".mirror-sparse", hidePaths: [] as string[] };

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mirror-"));
  await git.init({ fs, dir, defaultBranch: "main" });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("applyRef", () => {
  it("按名单决定落盘范围，被排除的顶层项不出现", async () => {
    await put("docs/a.md", "A");
    await put("internal/x.md", "X");
    await put(".mirror-sparse", "/*\n!/internal/\n");
    const oid = await commitAsRemote("v1");
    await rm(join(dir, "internal"), { recursive: true, force: true });

    const landed = await applyRef({ fs, dir, oid, ...OPTS });

    expect(landed).toContain("docs");
    expect(landed).not.toContain("internal");
    expect(existsSync(join(dir, "internal"))).toBe(false);
    expect(await readFile(join(dir, "docs/a.md"), "utf8")).toBe("A");
  });

  it("跟踪区被手工改动 → 同步后还原", async () => {
    await put("docs/a.md", "server content");
    const oid = await commitAsRemote("v1");
    await writeFile(join(dir, "docs/a.md"), "user edit");

    await applyRef({ fs, dir, oid, ...OPTS });

    expect(await readFile(join(dir, "docs/a.md"), "utf8")).toBe("server content");
  });

  it("未跟踪的用户文件原样还在 —— 永远不能被碰", async () => {
    await put("docs/a.md", "A");
    const oid = await commitAsRemote("v1");
    await mkdir(join(dir, "my-notes"), { recursive: true });
    await writeFile(join(dir, "my-notes/idea.md"), "do not delete");

    await applyRef({ fs, dir, oid, ...OPTS });

    expect(await readFile(join(dir, "my-notes/idea.md"), "utf8")).toBe("do not delete");
  });

  it("远端删掉的文件，本地也要消失", async () => {
    await put("docs/a.md", "A");
    await put("docs/b.md", "B");
    await commitAsRemote("v1");
    await git.remove({ fs, dir, filepath: "docs/b.md" });
    await rm(join(dir, "docs/b.md"), { force: true });
    const oid2 = await commitAsRemote("v2");
    await writeFile(join(dir, "docs/b.md"), "stale");

    await applyRef({ fs, dir, oid: oid2, ...OPTS });

    expect(existsSync(join(dir, "docs/b.md"))).toBe(false);
    expect(existsSync(join(dir, "docs/a.md"))).toBe(true);
  });

  it("目录被掏空后空目录也要收掉", async () => {
    await put("docs/2026/09/a.md", "A");
    await commitAsRemote("v1");
    await git.remove({ fs, dir, filepath: "docs/2026/09/a.md" });
    await put("docs/x.md", "X");
    const oid = await commitAsRemote("v2");

    await applyRef({ fs, dir, oid, ...OPTS });

    expect(existsSync(join(dir, "docs/2026"))).toBe(false);
    expect(existsSync(join(dir, "docs/x.md"))).toBe(true);
  });

  it("整个顶层目录从远端消失 → 本地那份也要清掉", async () => {
    await put("docs/a.md", "A");
    await put("tickers/x.md", "T");
    const oid1 = await commitAsRemote("v1");
    // 先真同步一轮 —— 剪枝要靠「上一次 main 的树」才知道 tickers 曾经归服务端所有。
    // 直接跳到 v2 是不真实的时序：git.commit 会顺手推进 main，那样「上一次」就等于
    // 「这一次」，测不出想测的东西。
    await applyRef({ fs, dir, oid: oid1, ...OPTS });
    expect(existsSync(join(dir, "tickers/x.md"))).toBe(true);

    await git.remove({ fs, dir, filepath: "tickers/x.md" });
    const oid2 = await commitAsRemote("v2");

    await applyRef({ fs, dir, oid: oid2, ...OPTS });

    expect(existsSync(join(dir, "tickers"))).toBe(false);
    expect(existsSync(join(dir, "docs/a.md"))).toBe(true);
  });

  it("新加进名单的排除项，本地那份要消失", async () => {
    await put("docs/a.md", "A");
    await put("internal/x.md", "X");
    await put(".mirror-sparse", "/*\n");
    const oid1 = await commitAsRemote("v1");
    await applyRef({ fs, dir, oid: oid1, ...OPTS });
    expect(existsSync(join(dir, "internal/x.md"))).toBe(true);

    await put(".mirror-sparse", "/*\n!/internal/\n");
    const oid2 = await commitAsRemote("v2");

    await applyRef({ fs, dir, oid: oid2, ...OPTS });

    expect(existsSync(join(dir, "internal"))).toBe(false);
  });

  it("index 是系统 git 写的 v3 → 自动重建，不能卡死", async () => {
    // isomorphic-git 硬性只认 dircache v2。用户若曾用系统 git + sparse-checkout
    // 操作过这个库，skip-worktree 位会让 index 变成 v3，读到就抛
    // "Unsupported dircache version: 3"。index 只是缓存，删掉让 checkout 重建。
    await put("docs/a.md", "A");
    const oid = await commitAsRemote("v1");
    const idx = join(dir, ".git/index");
    const buf = await readFile(idx);
    buf.writeUInt32BE(3, 4);
    await writeFile(idx, buf);

    const landed = await applyRef({ fs, dir, oid, ...OPTS });

    expect(landed).toContain("docs");
    expect(await readFile(join(dir, "docs/a.md"), "utf8")).toBe("A");
  });

  it("checkout 失败时 main 不能先指过去 —— 否则 HEAD 与工作区静默错位", async () => {
    await put("docs/a.md", "v1");
    const first = await commitAsRemote("v1");
    await applyRef({ fs, dir, oid: first, ...OPTS });

    await put("docs/a.md", "v2");
    const second = await commitAsRemote("v2");
    await git.writeRef({ fs, dir, ref: "refs/heads/main", value: first, force: true });
    // 让 checkout 写工作区时必然失败：把目标文件位置换成目录，写文件会 EISDIR。
    // 比代理 fs 可靠 —— isomorphic-git 内部走哪个写入口是它的实现细节。
    await rm(join(dir, "docs/a.md"), { force: true });
    await mkdir(join(dir, "docs/a.md"), { recursive: true });

    await expect(applyRef({ fs, dir, oid: second, ...OPTS })).rejects.toThrow();

    expect(await git.resolveRef({ fs, dir, ref: "refs/heads/main" })).toBe(first);
  });

  it("远端 force push（历史被换掉）也能同步过去", async () => {
    await put("docs/a.md", "old");
    const old = await commitAsRemote("v1");
    await applyRef({ fs, dir, oid: old, ...OPTS });

    // 造一条**无共同祖先**的历史：parent 显式给空数组。
    await writeFile(join(dir, "docs/a.md"), "new");
    await git.add({ fs, dir, filepath: "docs/a.md" });
    const fresh = await git.commit({
      fs, dir, message: "rewritten", parent: [],
      author: { name: "server", email: "s@local" },
    });
    await git.writeRef({ fs, dir, ref: "refs/remotes/origin/main", value: fresh, force: true });

    await applyRef({ fs, dir, oid: fresh, ...OPTS });
    expect(await readFile(join(dir, "docs/a.md"), "utf8")).toBe("new");
  });
});
