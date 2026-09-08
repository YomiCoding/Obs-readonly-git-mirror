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
 * 公开副本里没有那个文件，本测试会跳过并说明原因；内部 CI 上它一定存在、一定运行。
 */
const LIST = join(__dirname, "..", "..", ".internal-identifiers");
const SKIP_DIRS = new Set(["node_modules", "dist", ".git"]);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

describe("源码可公开", () => {
  it.skipIf(!existsSync(LIST))("不含任何内部标识", () => {
    const words = readFileSync(LIST, "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));
    expect(words.length).toBeGreaterThan(0);

    const hits: string[] = [];
    for (const f of walk(join(__dirname, ".."))) {
      const text = readFileSync(f, "utf8").toLowerCase();
      for (const w of words) {
        if (text.includes(w.toLowerCase())) hits.push(`${f} 含 "${w}"`);
      }
    }
    expect(hits).toEqual([]);
  });
});
