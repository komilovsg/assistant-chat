// Bundles the frontend: src/client/main.ts → public/app.js, src/widget/index.ts → public/widget.js.
// `node build.mjs --watch` rebuilds on change. CSS imports become strings (widget injects them into its Shadow DOM).
import * as esbuild from "esbuild";
import { existsSync } from "node:fs";

const watch = process.argv.includes("--watch");
const entries = [
  { in: "src/client/main.ts", out: "public/app.js" },
  { in: "src/widget/index.ts", out: "public/widget.js" },
];

const common = {
  bundle: true,
  format: "iife",
  minify: true,
  target: "es2020",
  sourcemap: false,
  legalComments: "none",
  loader: { ".css": "text" },
  logLevel: "info",
};

for (const e of entries) {
  if (!existsSync(e.in)) {
    console.warn(`[build] skip ${e.in}: file not found`);
    continue;
  }
  const opts = { ...common, entryPoints: [e.in], outfile: e.out };
  if (watch) await (await esbuild.context(opts)).watch();
  else await esbuild.build(opts);
}
if (watch) console.log("[build] watching…");
