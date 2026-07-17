#!/usr/bin/env bun
import { rm } from "node:fs/promises";
import { join } from "node:path";
import tailwind from "bun-plugin-tailwind";

const outdir = join(import.meta.dir, "dist");
await rm(outdir, { recursive: true, force: true });

const result = await Bun.build({
  entrypoints: [join(import.meta.dir, "src/index.html")],
  outdir,
  plugins: [tailwind],
  minify: true,
  target: "browser",
  sourcemap: "linked",
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
});

if (!result.success) throw new AggregateError(result.logs, "Build failed");
for (const output of result.outputs) {
  console.log(`${output.path}: ${(output.size / 1024).toFixed(1)} KB`);
}
