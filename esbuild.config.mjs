import esbuild from "esbuild";
import { copyFileSync, mkdirSync } from "node:fs";

mkdirSync("dist", { recursive: true });

await esbuild.build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  outfile: "dist/main.js",
  format: "cjs",
  platform: "browser",
  target: "es2022",
  external: ["obsidian", "electron", "fs", "path", "crypto"],
  // 政策禁止混淆代码。minify 只做体积压缩、不改变可读语义，是允许的；
  // 但保留函数名，便于审核者与用户看懂堆栈。
  minify: true,
  keepNames: true,
  logLevel: "info",
});

copyFileSync("manifest.json", "dist/manifest.json");
