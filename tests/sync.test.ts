import fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../src/config";
import { SyncError, fetchRemote } from "../src/sync";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "mirror-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const deps = () => ({
  fs, dir,
  cfg: { ...DEFAULT_CONFIG, repoUrl: "https://h:8443/g/r.git", tokenUser: "u", token: "tok-abc" },
  http: { request: vi.fn() },
});

describe("fetchRemote", () => {
  it("401 → kind=auth，文案里没有令牌", async () => {
    const d = deps();
    d.http.request.mockResolvedValue({
      url: d.cfg.repoUrl, method: "GET", statusCode: 401, statusMessage: "401",
      headers: {}, body: [new Uint8Array()],
    });
    const err: unknown = await fetchRemote(d as never).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SyncError);
    expect((err as SyncError).kind).toBe("auth");
    expect(String(err)).not.toContain("tok-abc");
  });

  it("连不上 → kind=network", async () => {
    const d = deps();
    d.http.request.mockRejectedValue(new Error("net::ERR_CONNECTION_REFUSED"));
    const err: unknown = await fetchRemote(d as never).catch((e: unknown) => e);
    expect((err as SyncError).kind).toBe("network");
  });

  it("其它错误也不能把令牌带出来 —— 错误会显示在设置页上", async () => {
    const d = deps();
    d.http.request.mockRejectedValue(new Error("boom, token tok-abc leaked"));
    const err: unknown = await fetchRemote(d as never).catch((e: unknown) => e);
    expect(String(err)).not.toContain("tok-abc");
    expect(String(err)).toContain("***");
  });
});
