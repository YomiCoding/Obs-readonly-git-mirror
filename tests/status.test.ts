import { describe, expect, it } from "vitest";
import { statusText } from "../src/status";

const T = new Date("2026-09-08T10:30:00").getTime();

describe("statusText", () => {
  it("同步中", () => {
    expect(statusText({ syncing: true, lastSyncAt: 0, lastError: "" })).toBe("Mirror: syncing…");
  });

  it("成功后显示时刻", () => {
    expect(statusText({ syncing: false, lastSyncAt: T, lastError: "" })).toBe("Mirror: synced 10:30");
  });

  it("从未同步过", () => {
    expect(statusText({ syncing: false, lastSyncAt: 0, lastError: "" })).toBe("Mirror: not synced yet");
  });

  it("失败必须明说，不能装作没事", () => {
    expect(statusText({ syncing: false, lastSyncAt: T, lastError: "认证失败" }))
      .toBe("Mirror: failed · 认证失败");
  });

  it("失败优先于成功时刻 —— 上次成功过不等于现在是好的", () => {
    expect(statusText({ syncing: false, lastSyncAt: T - 3600_000, lastError: "连不上服务器" }))
      .toContain("failed");
  });
});
