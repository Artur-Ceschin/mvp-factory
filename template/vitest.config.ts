import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { defineConfig, type Plugin } from "vitest/config";

// Mirrors esbuild's text loader so tests can import .html/.css/.txt like the Lambda bundle does.
// Imports resolve to "<file>.text.js" so Vite/Vitest CSS handling never sees a .css id, then load as strings.
const rawText = (): Plugin => ({
  name: "raw-text",
  enforce: "pre",
  resolveId(source, importer) {
    if (/\.(html|css|txt)$/.test(source) && importer) return `${resolve(dirname(importer), source)}.text.js`;
  },
  load(id) {
    const m = /^(.+\.(?:html|css|txt))\.text\.js$/.exec(id);
    if (m) return `export default ${JSON.stringify(readFileSync(m[1]!, "utf8"))};`;
  },
});

export default defineConfig({
  plugins: [rawText()],
  test: {
    environment: "node",
    env: {
      DB_DRIVER: "memory",
      AI_DRIVER: "stub",
      JWT_SECRET: "test-secret",
      ADMIN_TOKEN: "test-admin",
      APP_NAME: "Test App",
      PRICE_CENTS: "1990",
      PRICE_CURRENCY: "usd",
      APP_LOCALE: "en-US",
    },
  },
});
