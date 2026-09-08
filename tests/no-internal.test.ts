import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 「源码可以公开」的机器化保证：扫描本目录，出现任何内部标识就失败。
 *
 * 禁用词名单**不写在这里**，而是放在仓库根的 `.internal-identifiers`。原因：
 * 那份名单本身就是一份内部标识清单，写在插件目录里、跟着插件公开出去，
 * 等于把要藏的东西一次性全交出来。
 *
 * ⚠ 本文件（包括注释与测试名）里也不得出现任何一个禁用词：护栏会扫描自己。
 * 这条踩过两次 —— 一次把名单写死在这里，一次在注释里举例。
 *
 * 公开副本里没有那个文件，两条测试都会跳过；内部 CI 上它一定存在、一定运行。
 */
const LIST = join(__dirname, "..", "..", ".internal-identifiers");
const SKIP_DIRS = new Set(["node_modules", "dist", ".git"]);

/**
 * 锁文件不参与短词扫描：里面全是包名和 base64 校验和，名单里的三字母短词撞进
 * 某个哈希是必然的（实测撞过一次），会让护栏每次升级依赖就假红。
 * 它们改用「够长因而不可能碰巧出现」的那部分词单独查一遍。
 */
const SKIP_FILES = new Set(["package-lock.json"]);
const LONG_ENOUGH = 6;

function words(): string[] {
  return readFileSync(LIST, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (!SKIP_FILES.has(name)) out.push(p);
  }
  return out;
}

describe("源码可公开", () => {
  it.skipIf(!existsSync(LIST))("不含任何内部标识", () => {
    const list = words();
    expect(list.length).toBeGreaterThan(0);

    const hits: string[] = [];
    for (const f of walk(join(__dirname, ".."))) {
      const text = readFileSync(f, "utf8").toLowerCase();
      for (const w of list) {
        if (text.includes(w.toLowerCase())) hits.push(`${f} 含一个禁用词`);
      }
    }
    expect(hits).toEqual([]);
  });

  it.skipIf(!existsSync(LIST))("锁文件里没有内部包地址", () => {
    const long = words().filter((w) => w.length >= LONG_ENOUGH);
    expect(long.length).toBeGreaterThan(0);

    for (const name of SKIP_FILES) {
      const p = join(__dirname, "..", name);
      if (!existsSync(p)) continue;
      const text = readFileSync(p, "utf8").toLowerCase();
      for (const w of long) expect(text).not.toContain(w.toLowerCase());
    }
  });
});
