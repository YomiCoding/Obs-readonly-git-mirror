import fs from "node:fs";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import git from "isomorphic-git";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../src/config";
import { fetchRemote } from "../src/sync";

/**
 * 首次 clone 的分支：**目录里还没有 .git**。
 *
 * 这是新用户唯一会走的路（空库 + 配置 → 自动拉下整个仓库），而前面那些用例
 * 全是对已存在的仓库跑 applyRef，一条都覆盖不到它。
 *
 * 这里只钉「没有 .git 就 init + addRemote 再 fetch」这段逻辑：isomorphic-git 只支持
 * HTTP、拉不了本地路径，起一个 git HTTP 服务器不值得。真实远端的端到端验证见
 * spec §9（已实测：空目录 → 完整仓库 3.1 秒，名单生效，用户文件未被碰）。
 */
let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "empty-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe("首次 clone", () => {
  it("目录里没有 .git 时先 init 并配好 origin，再去 fetch", async () => {
    const cfg = { ...DEFAULT_CONFIG, repoUrl: "https://h/r.git", tokenUser: "u", token: "t" };
    // 让 fetch 立刻失败：我们只关心它之前的 init + addRemote 有没有做对。
    const http = { request: vi.fn().mockRejectedValue(new Error("net::ERR_CONNECTION_REFUSED")) };

    expect(existsSync(join(dir, ".git"))).toBe(false);

    await expect(fetchRemote({ fs, http, dir, cfg })).rejects.toThrow();

    expect(existsSync(join(dir, ".git"))).toBe(true);
    const remotes = await git.listRemotes({ fs, dir });
    expect(remotes).toEqual([{ remote: "origin", url: "https://h/r.git" }]);
    expect(http.request).toHaveBeenCalled();
  });
});
