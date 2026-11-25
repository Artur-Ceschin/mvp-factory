import { readFileSync } from "node:fs";
import { defineConfig, type Plugin } from "vitest/config";

// Mirrors esbuild's text loader so tests can import .html/.css/.txt like the Lambda bundle does.
const rawText = (): Plugin => ({
  name: "raw-text",
  enforce: "pre",
  load(id) {
    if (/\.(html|css|txt)$/.test(id)) return `export default ${JSON.stringify(readFileSync(id, "utf8"))};`;
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
