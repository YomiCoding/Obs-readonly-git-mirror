/**
 * 读者在 Obsidian 里删了镜像里的文件：上报给服务端，被接受的这一轮不恢复、之后每轮继续压住，
 * 直到远端树里也没有它；没被接受（服务端拒绝 / 没配上报地址 / 网络不通）的照旧恢复。
 */
import { existsSync } from "node:fs";
import fs from "node:fs";
import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import git from "isomorphic-git";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../src/config";
import type { RequestUrlFn } from "../src/http";
import { PENDING_TTL_MS, SyncError, applyRef, detectLocalDeletions, reportDeletions, syncTree, withTimeout } from "../src/sync";

let dir: string;

async function put(rel: string, content: string) {
  const p = join(dir, rel);
  await mkdir(join(p, ".."), { recursive: true });
  await writeFile(p, content);
  await git.add({ fs, dir, filepath: rel });
}

async function commitAsRemote(message: string): Promise<string> {
  const before = await git.resolveRef({ fs, dir, ref: "refs/heads/main" }).catch(() => null);
  const oid = await git.commit({ fs, dir, message, author: { name: "server", email: "s@local" } });
  if (before) await git.writeRef({ fs, dir, ref: "refs/heads/main", value: before, force: true });
  await git.writeRef({ fs, dir, ref: "refs/remotes/origin/main", value: oid, force: true });
  return oid;
}

const OPTS = { sparseFile: ".mirror-sparse", hidePaths: [] as string[] };
const IDENTITY = { user: "reader", host: "laptop" };

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mirror-"));
  await git.init({ fs, dir, defaultBranch: "main" });
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

/** 服务端推一版并落盘，返回 oid。 */
async function landed(files: Record<string, string>, sparse = "/*\n!/openwiki/\n"): Promise<string> {
  await put(".mirror-sparse", sparse);
  for (const [k, v] of Object.entries(files)) await put(k, v);
  const oid = await commitAsRemote("v");
  await applyRef({ fs, dir, oid, ...OPTS });
  return oid;
}

describe("detectLocalDeletions", () => {
  it("上一轮落盘、现在不见了的受跟踪文件 = 读者删的；隐藏目录里的和远端已删的都不算", async () => {
    const oid = await landed({ "docs/a.md": "a", "docs/b.md": "b", "openwiki/x.md": "x" });
    await unlink(join(dir, "docs/a.md"));
    expect(await detectLocalDeletions({ fs, dir, oid, ...OPTS })).toEqual(["docs/a.md"]);

    // 远端这一版删掉了 b：本地即使也没了，那是远端的删除，不该上报
    await git.remove({ fs, dir, filepath: "docs/b.md" });
    const oid2 = await commitAsRemote("remove b");
    await unlink(join(dir, "docs/b.md"));
    expect(await detectLocalDeletions({ fs, dir, oid: oid2, ...OPTS })).toEqual(["docs/a.md"]);
  });
});

describe("reportDeletions", () => {
  it("带 Bearer 令牌 POST JSON，回 accepted；非 2xx 抛 SyncError 且不带令牌", async () => {
    const request = vi.fn<RequestUrlFn>().mockResolvedValue({
      status: 200, headers: {},
      arrayBuffer: new TextEncoder().encode(JSON.stringify({ accepted: ["docs/a.md"], rejected: ["topics/x.md"], unknown: [] })).buffer,
    });
    const cfg = { ...DEFAULT_CONFIG, deleteReportUrl: "https://kb/api/vault/deletions", deleteReportToken: "tok-del", reporterName: "Reader One" };
    const r = await reportDeletions(request, cfg, ["docs/a.md", "topics/x.md"], IDENTITY);
    expect(r).toEqual(["docs/a.md"]);
    const call = request.mock.calls[0][0];
    expect(call.url).toBe(cfg.deleteReportUrl);
    expect(call.method).toBe("POST");
    expect(call.headers.Authorization).toBe("Bearer tok-del");
    expect(JSON.parse(new TextDecoder().decode(call.body as ArrayBuffer))).toEqual({
      paths: ["docs/a.md", "topics/x.md"], reporter: "Reader One", user: "reader", host: "laptop",
    });

    request.mockResolvedValue({ status: 401, headers: {}, arrayBuffer: new ArrayBuffer(0) });
    const err: unknown = await reportDeletions(request, cfg, ["docs/a.md"], IDENTITY).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SyncError);
    expect(String(err)).not.toContain("tok-del");
  });
});

describe("syncTree", () => {
  it("接受的删除这一轮不恢复、进 pending；下一轮不再上报但继续压住；远端删掉后从 pending 消失", async () => {
    const oid = await landed({ "docs/a.md": "a", "docs/b.md": "b" });
    await unlink(join(dir, "docs/a.md"));
    const report = vi.fn().mockResolvedValue(["docs/a.md"]);
    const r1 = await syncTree({ fs, dir, oid, ...OPTS, pending: [], report });
    expect(r1.accepted).toEqual(["docs/a.md"]);
    expect(r1.rejected).toEqual([]);
    expect(r1.pending).toEqual(["docs/a.md"]);
    expect(existsSync(join(dir, "docs/a.md"))).toBe(false);
    expect(existsSync(join(dir, "docs/b.md"))).toBe(true);

    const r2 = await syncTree({ fs, dir, oid, ...OPTS, pending: r1.pending, report });
    expect(report).toHaveBeenCalledTimes(1);
    expect(existsSync(join(dir, "docs/a.md"))).toBe(false);
    expect(r2.pending).toEqual(["docs/a.md"]);

    await git.remove({ fs, dir, filepath: "docs/a.md" });
    const oid2 = await commitAsRemote("server deleted a");
    const r3 = await syncTree({ fs, dir, oid: oid2, ...OPTS, pending: r2.pending, report });
    expect(r3.pending).toEqual([]);
    expect(existsSync(join(dir, "docs/a.md"))).toBe(false);
  });

  it("服务端拒绝的照旧恢复，并列在 rejected 里", async () => {
    const oid = await landed({ "topics/x.md": "x" });
    await unlink(join(dir, "topics/x.md"));
    const report = vi.fn().mockResolvedValue([]);
    const r = await syncTree({ fs, dir, oid, ...OPTS, pending: [], report });
    expect(r.rejected).toEqual(["topics/x.md"]);
    expect(existsSync(join(dir, "topics/x.md"))).toBe(true);
  });

  it("没配上报（report 为空）→ 不上报、照旧恢复；上报抛错 → 恢复且错误带出去给状态栏", async () => {
    const oid = await landed({ "docs/a.md": "a" });
    await unlink(join(dir, "docs/a.md"));
    const r = await syncTree({ fs, dir, oid, ...OPTS, pending: [], report: null });
    expect(r.rejected).toEqual(["docs/a.md"]);
    expect(existsSync(join(dir, "docs/a.md"))).toBe(true);

    await unlink(join(dir, "docs/a.md"));
    const failing = vi.fn().mockRejectedValue(new SyncError("network", "连不上服务器：请检查网络"));
    const r2 = await syncTree({ fs, dir, oid, ...OPTS, pending: [], report: failing });
    expect(r2.rejected).toEqual(["docs/a.md"]);
    expect(r2.reportError).toContain("连不上");
    expect(existsSync(join(dir, "docs/a.md"))).toBe(true);
  });
});


describe("reportDeletions timeout", () => {
  it("服务端永不回应 → 限时抛 SyncError(network)，同步不会永远挂住", async () => {
    const never = vi.fn<RequestUrlFn>().mockReturnValue(new Promise(() => undefined));
    const cfg = { ...DEFAULT_CONFIG, deleteReportUrl: "https://kb/api", deleteReportToken: "tok" };
    const err: unknown = await reportDeletions(never, cfg, ["docs/a.md"], IDENTITY, 20).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SyncError);
    expect((err as SyncError).kind).toBe("network");
    expect(String(err)).toContain("timed out");
  });

  it("withTimeout 正常返回时不影响结果", async () => {
    expect(await withTimeout(Promise.resolve(7), 1000, "x")).toBe(7);
  });
});


describe("pending 的期限", () => {
  it("服务端接受后 30 分钟仍没从远端删掉（比如管理员恢复了）→ 放回本地，不再压住，也不再自动上报", async () => {
    const oid = await landed({ "docs/a.md": "a" });
    await unlink(join(dir, "docs/a.md"));
    const report = vi.fn().mockResolvedValue(["docs/a.md"]);
    const t0 = 1_000_000;
    const r1 = await syncTree({ fs, dir, oid, ...OPTS, pending: [], report, now: t0 });
    expect(r1.pending).toEqual(["docs/a.md"]);
    expect(r1.pendingSince).toEqual({ "docs/a.md": t0 });

    const r2 = await syncTree({ fs, dir, oid, ...OPTS, pending: r1.pending, pendingSince: r1.pendingSince, report, now: t0 + PENDING_TTL_MS - 1 });
    expect(r2.pending).toEqual(["docs/a.md"]);
    expect(existsSync(join(dir, "docs/a.md"))).toBe(false);

    const r3 = await syncTree({ fs, dir, oid, ...OPTS, pending: r2.pending, pendingSince: r2.pendingSince, report, now: t0 + PENDING_TTL_MS + 1 });
    expect(r3.expired).toEqual(["docs/a.md"]);
    expect(r3.pending).toEqual([]);
    expect(existsSync(join(dir, "docs/a.md"))).toBe(true);
    expect(report).toHaveBeenCalledTimes(1);                                  // 放回来那一轮没再报
  });

  it("老版本状态里没有 pendingSince → 从本轮开始计时", async () => {
    const oid = await landed({ "docs/a.md": "a" });
    await unlink(join(dir, "docs/a.md"));
    const r = await syncTree({ fs, dir, oid, ...OPTS, pending: ["docs/a.md"], report: null, now: 5 });
    expect(r.pending).toEqual(["docs/a.md"]);
    expect(r.pendingSince).toEqual({ "docs/a.md": 5 });
  });
});
