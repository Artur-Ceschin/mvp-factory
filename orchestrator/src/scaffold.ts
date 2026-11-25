import { cpSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config.js";
import { paths } from "./config.js";
import { ideaToSpec, type Idea } from "./ideas.js";

const SKIP = new Set(["node_modules", "dist", ".serverless"]);

/** Files owned by the template. Apps may not change them; `factory sync-core` re-copies them. */
export const PROTECTED = [
  "src/core",
  "src/types.d.ts",
  "tests/core.test.ts",
  "tests/helpers.ts",
  "serverless.yml",
  "build.mjs",
  "vitest.config.ts",
  "tsconfig.json",
  "dev.ts",
  ".gitignore",
];

export const appDir = (slug: string) => join(paths.apps, slug);

export function scaffold(idea: Idea, cfg: Config, opts: { force?: boolean } = {}) {
  const dir = appDir(idea.slug);
  if (existsSync(dir) && !opts.force) throw new Error(`${dir} already exists (use --force to recreate)`);
  cpSync(paths.template, dir, {
    recursive: true,
    filter: (src) => !SKIP.has(src.split(/[\\/]/).pop() ?? ""),
  });
  writeAppMeta(idea, cfg);
  const pkgPath = join(dir, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  pkg.name = `mvp-${idea.slug}`;
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
  writeFileSync(join(dir, "SPEC.md"), ideaToSpec(idea));
  return dir;
}

/** factory.app.json drives serverless.yml (name, price, model). Re-written on every deploy. */
export function writeAppMeta(idea: Idea, cfg: Config) {
  writeFileSync(
    join(appDir(idea.slug), "factory.app.json"),
    JSON.stringify(
      {
        slug: idea.slug,
        name: idea.name,
        priceCents: idea.pricing.monthlyCents,
        currency: idea.pricing.currency.toLowerCase(),
        bedrockModelId: cfg.runtime.bedrockModelId,
        bedrockRegion: cfg.runtime.bedrockRegion,
      },
      null,
      2,
    ) + "\n",
  );
}

function listFiles(base: string, rel: string): string[] {
  const full = join(base, rel);
  if (!existsSync(full)) return [];
  if (statSync(full).isFile()) return [rel];
  return readdirSync(full).flatMap((f) => (SKIP.has(f) ? [] : listFiles(base, join(rel, f))));
}

/** Returns protected paths whose content differs from the template (or is missing/extra). */
export function coreDrift(dir: string): string[] {
  const drift: string[] = [];
  for (const p of PROTECTED) {
    const tFiles = new Set(listFiles(paths.template, p));
    const aFiles = new Set(listFiles(dir, p));
    for (const f of new Set([...tFiles, ...aFiles])) {
      if (!tFiles.has(f) || !aFiles.has(f)) drift.push(f);
      else if (!readFileSync(join(paths.template, f)).equals(readFileSync(join(dir, f)))) drift.push(f);
    }
  }
  return drift;
}

export function syncCore(dir: string) {
  for (const p of PROTECTED) {
    const src = join(paths.template, p);
    if (existsSync(src)) cpSync(src, join(dir, p), { recursive: true, force: true });
  }
}

export function dependencyDrift(dir: string): string[] {
  const t = JSON.parse(readFileSync(join(paths.template, "package.json"), "utf8"));
  const a = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const issues: string[] = [];
  for (const field of ["dependencies", "devDependencies", "scripts"] as const) {
    if (JSON.stringify(t[field] ?? {}) !== JSON.stringify(a[field] ?? {})) issues.push(`package.json ${field} differs from template`);
  }
  return issues;
}

/** All app-owned source files (what the agent writes). */
export function appFiles(dir: string): string[] {
  return [...listFiles(dir, "src/app"), ...listFiles(dir, "tests").filter((f) => !PROTECTED.includes(f))];
}
