import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, decodeSetupCode, encodeConfig, isConfigured } from "../src/config";
import { SetupCodeGate } from "../src/setup-gate";
import { statusText } from "../src/status";

describe("decodeSetupCode", () => {
  it("recognises an inbox claim code", () => {
    const code = Buffer.from(JSON.stringify({ v: 2, endpoint: "https://inbox.example/api/v1", claim: "C123" })).toString("base64url");
    expect(decodeSetupCode(code)).toEqual({ kind: "claim", endpoint: "https://inbox.example/api/v1", claim: "C123" });
  });
  it("still accepts a mirror configuration", () => {
    const code = decodeSetupCode(encodeConfig({ ...DEFAULT_CONFIG, repoUrl: "https://example.com/r.git", token: "t" }));
    expect(code.kind).toBe("git");
  });
  it("rejects a claim without a usable endpoint or claim", () => {
    for (const bad of [{ v: 2, claim: "C" }, { v: 2, endpoint: "ftp://x", claim: "C" }, { v: 2, endpoint: "https://x" }]) {
      expect(() => decodeSetupCode(Buffer.from(JSON.stringify(bad)).toString("base64url"))).toThrow();
    }
  });
});

describe("isConfigured", () => {
  it("needs an endpoint and a device token in inbox mode", () => {
    expect(isConfigured({ ...DEFAULT_CONFIG, mode: "inbox", endpoint: "https://x", deviceToken: "t" })).toBe(true);
    expect(isConfigured({ ...DEFAULT_CONFIG, mode: "inbox", endpoint: "https://x" })).toBe(false);
  });
});

describe("statusText", () => {
  it("names the mode", () => {
    expect(statusText({ syncing: false, lastSyncAt: 0, lastError: "", mode: "inbox" })).toBe("Inbox: not synced yet");
    expect(statusText({ syncing: false, lastSyncAt: 0, lastError: "" })).toBe("Mirror: not synced yet");
  });
});

describe("SetupCodeGate", () => {
  it("does not submit a code again once it was applied", () => {
    const gate = new SetupCodeGate();
    expect(gate.shouldApply("CODE")).toBe(true);
    gate.applied("CODE");
    expect(gate.shouldApply("CODE")).toBe(false);
    expect(gate.shouldApply("OTHER")).toBe(true);
  });
  it("retries the same code after a failed attempt and ignores empty input", () => {
    const gate = new SetupCodeGate();
    expect(gate.shouldApply("CODE")).toBe(true);
    expect(gate.shouldApply("CODE")).toBe(true);
    expect(gate.shouldApply("")).toBe(false);
  });
});
