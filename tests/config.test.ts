import { describe, expect, it } from "vitest";
import {
  ConfigError, DEFAULT_CONFIG, decodeConfig, encodeConfig, isConfigured,
} from "../src/config";

const sample = {
  repoUrl: "https://host:8443/g/repo.git",
  tokenUser: "reader",
  token: "secret-token",
  sparseFile: ".mirror-sparse",
  hidePaths: ["notes-internal", "README.md"],
};

describe("配置码", () => {
  it("编码后能原样解回来", () => {
    expect(decodeConfig(encodeConfig(sample))).toEqual(sample);
  });

  it("编码结果是一行、可安全放进 URL 查询参数", () => {
    const s = encodeConfig(sample);
    expect(s).not.toContain("\n");
    expect(encodeURIComponent(s)).toBe(s);
  });

  it("缺少必填字段 → 明确报错，不能静默接受", () => {
    const bad = encodeConfig({ ...sample, repoUrl: "" });
    expect(() => decodeConfig(bad)).toThrow(ConfigError);
    expect(() => decodeConfig(bad)).toThrow(/仓库地址/);
  });

  it("不是 base64 → 明确报错", () => {
    expect(() => decodeConfig("这不是配置码")).toThrow(ConfigError);
  });

  it("是 base64 但不是 JSON → 明确报错", () => {
    const notJson = Buffer.from("hello").toString("base64url");
    expect(() => decodeConfig(notJson)).toThrow(ConfigError);
  });

  it("缺省字段用默认值补齐，不报错", () => {
    const minimal = Buffer.from(JSON.stringify({
      repoUrl: "https://h/r.git", tokenUser: "u", token: "t",
    })).toString("base64url");
    const c = decodeConfig(minimal);
    expect(c.sparseFile).toBe(DEFAULT_CONFIG.sparseFile);
    expect(c.hidePaths).toEqual([]);
  });

  it("默认配置里不带任何凭据", () => {
    expect(DEFAULT_CONFIG.repoUrl).toBe("");
    expect(DEFAULT_CONFIG.token).toBe("");
    expect(isConfigured(DEFAULT_CONFIG)).toBe(false);
  });

  it("地址或令牌为空都算未配置", () => {
    expect(isConfigured({ ...DEFAULT_CONFIG, repoUrl: "https://h/r.git" })).toBe(false);
    expect(isConfigured({ ...DEFAULT_CONFIG, repoUrl: "https://h/r.git", token: "t" })).toBe(true);
  });
});
