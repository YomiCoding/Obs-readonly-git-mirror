import fs from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import git from "isomorphic-git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { retireMirror } from "../src/sync";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "retire-"));
  await git.init({ fs, dir, defaultBranch: "main" });
  for (const [rel, text] of [["notes/a.md", "a"], ["notes/b.md", "b"], ["files/c.png", "c"]]) {
    await mkdir(join(dir, rel, ".."), { recursive: true });
    await writeFile(join(dir, rel), text);
    await git.add({ fs, dir, filepath: rel });
  }
  await git.commit({ fs, dir, message: "mirror", author: { name: "server", email: "s@local" } });
  await writeFile(join(dir, "mine.md"), "untracked note");
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe("retireMirror", () => {
  it("removes unchanged mirrored files and the repository, keeps edited and untracked files", async () => {
    await writeFile(join(dir, "notes/b.md"), "edited by me");
    const r = await retireMirror(fs, dir);
    expect(r).toEqual({ removed: 2, kept: 1 });
    expect(fs.existsSync(join(dir, "notes/a.md"))).toBe(false);
    expect(fs.existsSync(join(dir, "files"))).toBe(false);
    expect(await readFile(join(dir, "notes/b.md"), "utf8")).toBe("edited by me");
    expect(await readFile(join(dir, "mine.md"), "utf8")).toBe("untracked note");
    expect(fs.existsSync(join(dir, ".git"))).toBe(false);
  });

  it("does nothing without a repository", async () => {
    await rm(join(dir, ".git"), { recursive: true, force: true });
    expect(await retireMirror(fs, dir)).toEqual({ removed: 0, kept: 0 });
    expect(fs.existsSync(join(dir, "notes/a.md"))).toBe(true);
  });
});
