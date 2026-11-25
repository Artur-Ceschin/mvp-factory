// Bundles the Lambda into dist/handler.mjs. .html/.css/.txt files are inlined as strings.
import { build } from "esbuild";

await build({
  entryPoints: ["src/core/handler.ts"],
  outfile: "dist/handler.mjs",
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  minify: true,
  sourcemap: false,
  // The Lambda Node.js 22 runtime ships AWS SDK v3.
  external: ["@aws-sdk/*"],
  loader: { ".html": "text", ".css": "text", ".txt": "text" },
  banner: {
    js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
  },
});
console.log("built dist/handler.mjs");
