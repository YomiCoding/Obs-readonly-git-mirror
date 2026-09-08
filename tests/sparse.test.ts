import { describe, expect, it } from "vitest";
import { parseExcludes, visiblePaths } from "../src/sparse";

describe("parseExcludes", () => {
  it("取出 ! 开头的排除项，去掉前导斜杠与尾随斜杠", () => {
    expect(parseExcludes("/*\n!/AGENTS.md\n!/internal/\n")).toEqual(["AGENTS.md", "internal"]);
  });

  it("忽略空行与注释行", () => {
    expect(parseExcludes("/*\n\n# comment\n!/README.md\n")).toEqual(["README.md"]);
  });

  it("没有排除项时返回空数组", () => {
    expect(parseExcludes("/*\n")).toEqual([]);
  });
});

describe("visiblePaths", () => {
  const top = ["docs", "assets", "my-notes", "internal", "AGENTS.md"];

  it("排除名单里的顶层项不落盘", () => {
    expect(visiblePaths(top, "/*\n!/internal/\n!/AGENTS.md\n", []))
      .toEqual(["docs", "assets", "my-notes"]);
  });

  it("名单文件缺失时用传入的兜底名单", () => {
    expect(visiblePaths(top, null, ["internal", "AGENTS.md"]))
      .toEqual(["docs", "assets", "my-notes"]);
  });

  it("名单文件缺失且没有兜底 → 全部可见", () => {
    expect(visiblePaths(top, null, [])).toEqual(top);
  });
});
