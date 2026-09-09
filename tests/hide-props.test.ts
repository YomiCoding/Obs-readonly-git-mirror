import { describe, expect, it } from "vitest";
import { inMirror } from "../src/hide-props";

describe("inMirror", () => {
  it("目标文件夹里的笔记算镜像内容", () => {
    expect(inMirror("kb/a/b.md", "kb")).toBe(true);
    expect(inMirror("kb", "kb")).toBe(true);
  });

  it("只是同前缀的另一个文件夹不算 —— 否则会把用户自己的 kb-notes 一起藏掉", () => {
    expect(inMirror("kb-notes/a.md", "kb")).toBe(false);
    expect(inMirror("kbx", "kb")).toBe(false);
  });

  it("深层同名文件夹不算：镜像只在库根下的那一个", () => {
    expect(inMirror("mine/kb/a.md", "kb")).toBe(false);
  });

  it("目标文件夹留空 = 整个库都是镜像", () => {
    expect(inMirror("anything.md", "")).toBe(true);
  });

  it("配置里手打的空格不算目录名的一部分", () => {
    expect(inMirror("kb/a.md", "  kb  ")).toBe(true);
  });
});
