import { describe, expect, it } from "vitest";
import { MIRROR_INTERVAL_MS, TICK_MS, dueForScheduledSync, intervalFor } from "../src/schedule";

describe("dueForScheduledSync", () => {
  it("runs an inbox sync on every tick", () => {
    expect(dueForScheduledSync("inbox", 0, TICK_MS)).toBe(true);
    expect(dueForScheduledSync("inbox", 0, TICK_MS / 2 - 1)).toBe(false);
  });

  it("keeps mirror mode on the slower interval and tolerates late timers", () => {
    expect(dueForScheduledSync("git", 0, TICK_MS * 3)).toBe(false);
    expect(dueForScheduledSync("git", 0, MIRROR_INTERVAL_MS - TICK_MS / 2)).toBe(true);
    expect(intervalFor("git")).toBe(MIRROR_INTERVAL_MS);
    expect(intervalFor(undefined)).toBe(MIRROR_INTERVAL_MS);   // 未配置过的老库按镜像模式对待
  });
});
