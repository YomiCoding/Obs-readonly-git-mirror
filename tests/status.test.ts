import { describe, expect, it } from "vitest";
import { statusText } from "../src/status";

const T = new Date("2026-09-08T10:30:00").getTime();

describe("statusText", () => {
  it("同步中", () => {
    expect(statusText({ syncing: true, lastSyncAt: 0, lastError: "" })).toBe("镜像：正在同步…");
  });

  it("成功后显示时刻", () => {
    expect(statusText({ syncing: false, lastSyncAt: T, lastError: "" })).toBe("镜像：已同步 10:30");
  });

  it("从未同步过", () => {
    expect(statusText({ syncing: false, lastSyncAt: 0, lastError: "" })).toBe("镜像：尚未同步");
  });

  it("失败必须明说，不能装作没事", () => {
    expect(statusText({ syncing: false, lastSyncAt: T, lastError: "认证失败" }))
      .toBe("镜像：同步失败 · 认证失败");
  });

  it("失败优先于成功时刻 —— 上次成功过不等于现在是好的", () => {
    expect(statusText({ syncing: false, lastSyncAt: T - 3600_000, lastError: "连不上服务器" }))
      .toContain("同步失败");
  });

  it("收件箱模式带上共享库的条数；共享库失败单独说，不影响收件箱那一半", () => {
    const base = { syncing: false, lastSyncAt: T, lastError: "", mode: "inbox" as const };
    expect(statusText({ ...base, shared: { active: true, entries: 42, error: "" } })).toBe("收件箱：已同步 10:30 · 共享库 42 条");
    expect(statusText({ ...base, shared: { active: true, entries: 42, error: "连不上服务器" } }))
      .toBe("收件箱：已同步 10:30 · 共享库同步失败（连不上服务器）");
    expect(statusText({ ...base, shared: { active: false, entries: 0, error: "" } })).toBe("收件箱：已同步 10:30");
    expect(statusText({ ...base, lastError: "认证失败", shared: { active: true, entries: 42, error: "" } }))
      .toBe("收件箱：同步失败 · 认证失败");
  });
});
