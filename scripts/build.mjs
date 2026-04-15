import * as esbuild from "esbuild";
import { rmSync } from "fs";

// Clean dist
try {
  rmSync("dist", { recursive: true, force: true });
} catch {}

const shared = {
  bundle: true,
  platform: "node",
  target: "node20",
  external: ["electron"],
  sourcemap: true,
  logLevel: "info",
};

// Build main process
await esbuild.build({
  ...shared,
  entryPoints: ["src/main.ts"],
  outfile: "dist/main.js",
  format: "cjs",
});

// Build preload script
await esbuild.build({
  ...shared,
  entryPoints: ["src/preload.ts"],
  outfile: "dist/preload.js",
  format: "cjs",
});

// Copy renderer files
import { cpSync } from "fs";
cpSync("src/renderer", "dist/renderer", { recursive: true });

console.log("✅ Build complete");
