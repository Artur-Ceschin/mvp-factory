// Validation gates every app must pass before it can be deployed.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Env } from "./env.js";
import { log, run, tail } from "./exec.js";
import { PALETTE_TOKENS } from "./ideas.js";
import { appFiles, coreDrift, dependencyDrift } from "./scaffold.js";

export interface GateResult {
  gate: string;
  ok: boolean;
  output: string;
  ms: number;
}

const SECRET_PATTERNS: [RegExp, string][] = [
  [/sk_(live|test)_[0-9a-zA-Z]{10,}/, "Stripe secret key"],
  [/whsec_[0-9a-zA-Z]{10,}/, "Stripe webhook secret"],
  [/AKIA[0-9A-Z]{16}/, "AWS access key"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "private key"],
  [/sk-ant-[0-9a-zA-Z_-]{10,}/, "Anthropic API key"],
];

const CODE_POLICY: [RegExp, string][] = [
  [/\bchild_process\b/, "child_process is not allowed in app code"],
  [/\beval\s*\(/, "eval() is not allowed"],
  [/new\s+Function\s*\(/, "new Function() is not allowed"],
  [/innerHTML\s*[+]?=\s*`[^`]*\$\{/, "innerHTML with ${} interpolation (XSS risk) — build DOM nodes and use textContent"],
  [/process\.env\.(STRIPE|PLUGGY|JWT|ADMIN)/, "read secrets with secret()/requireSecret() from core/secrets, not process.env"],
  [/\bfrom\s+["'](?!\.\.?\/|node:)(?!@aws-sdk\/)[^"']+["']/, "only relative, node: and @aws-sdk/* imports are allowed (no new dependencies)"],
];

/** The only external host app web files may reference (fonts). */
export const ALLOWED_WEB_HOSTS = ["fonts.bunny.net"];
/** Tokens theme.css must define (the palette from SPEC.md plus the two font roles). */
export const REQUIRED_THEME_TOKENS = [...Object.values(PALETTE_TOKENS), "--font-display", "--font-body"];

// Emoji rendered as emoji (default emoji presentation, or forced with VS16). Plain symbols such
// as ©, ✓ or → are fine. Emoji typed by users never appear in index.html itself.
const EMOJI = /\p{Emoji_Presentation}|\p{Extended_Pictographic}\uFE0F/u;

/** Design rules for src/app/web: brand assets wired up, no external hosts, no emoji icons. */
export function designPolicy(dir: string): string[] {
  const hits: string[] = [];
  const web = join(dir, "src/app/web");
  const files = existsSync(web) ? readdirSync(web).filter((f) => statSync(join(web, f)).isFile()) : [];
  for (const f of files) {
    // xmlns="http://www.w3.org/2000/svg" is a namespace identifier, not a request.
    const src = readFileSync(join(web, f), "utf8").replace(/\sxmlns(:[\w-]+)?=["'][^"']*["']/g, "");
    const hosts = new Set<string>();
    for (const m of src.matchAll(/(?:https?:\/\/|["'(=]\s*\/\/)([a-z0-9-]+(?:\.[a-z0-9-]+)+)/gi)) hosts.add(m[1]!.toLowerCase());
    for (const h of hosts)
      if (!ALLOWED_WEB_HOSTS.includes(h))
        hits.push(`src/app/web/${f}: references external host ${h} (only ${ALLOWED_WEB_HOSTS.join(", ")} is allowed; inline assets instead)`);
  }

  const index = join(web, "index.html");
  if (existsSync(index)) {
    const html = readFileSync(index, "utf8");
    const links = [...html.matchAll(/<link\b[^>]*>/gi)].map((m) => m[0]);
    const stylesheet = (re: RegExp) => links.some((l) => /rel=["']?stylesheet/i.test(l) && re.test(l));
    if (!stylesheet(/href=["']\/_base\.css["']/)) hits.push('src/app/web/index.html: must link <link rel="stylesheet" href="/_base.css">');
    if (!stylesheet(/href=["']\/_theme\.css["']/)) hits.push('src/app/web/index.html: must link <link rel="stylesheet" href="/_theme.css">');
    if (!stylesheet(/href=["']https:\/\/fonts\.bunny\.net\/css\?/))
      hits.push("src/app/web/index.html: must load the brand fonts with a fonts.bunny.net stylesheet link (see SPEC.md)");
    html.split("\n").forEach((line, i) => {
      const m = EMOJI.exec(line.replace(/<!--[\s\S]*?-->/g, ""));
      if (m) hits.push(`src/app/web/index.html:${i + 1}: emoji "${m[0]}" used in the UI; use an inline SVG icon instead`);
    });
  }

  const themeFile = join(web, "theme.css");
  if (!existsSync(themeFile)) hits.push("missing src/app/web/theme.css (brand tokens from SPEC.md)");
  else {
    const theme = readFileSync(themeFile, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const missing = REQUIRED_THEME_TOKENS.filter((t) => !new RegExp(`${t}\\s*:`).test(theme));
    if (missing.length) hits.push(`src/app/web/theme.css: must define ${missing.join(", ")}`);
  }
  return hits;
}

function staticChecks(dir: string): GateResult[] {
  const t0 = Date.now();
  const files = appFiles(dir);
  const secretHits: string[] = [];
  const policyHits: string[] = [];
  for (const f of files) {
    const src = readFileSync(join(dir, f), "utf8");
    for (const [re, what] of SECRET_PATTERNS) if (re.test(src)) secretHits.push(`${f}: looks like a ${what}`);
    if (/\.(ts|html)$/.test(f) && !f.startsWith("tests/"))
      for (const [re, what] of CODE_POLICY) if (re.test(src)) policyHits.push(`${f}: ${what}`);
  }
  policyHits.push(...designPolicy(dir));
  const drift = coreDrift(dir);
  const deps = dependencyDrift(dir);
  const required = ["src/app/routes.ts", "src/app/manifest.ts", "src/app/web/index.html", "SPEC.md"].filter(
    (f) => !existsSync(join(dir, f)),
  );
  const ms = Date.now() - t0;
  return [
    {
      gate: "core-integrity",
      ok: drift.length === 0 && deps.length === 0 && required.length === 0,
      output: [
        ...drift.map((f) => `modified protected file: ${f} (only src/app/** and tests/app*.test.ts may change)`),
        ...deps,
        ...required.map((f) => `missing required file: ${f}`),
      ].join("\n"),
      ms,
    },
    { gate: "secret-scan", ok: secretHits.length === 0, output: secretHits.join("\n"), ms: 0 },
    { gate: "code-policy", ok: policyHits.length === 0, output: policyHits.join("\n"), ms: 0 },
  ];
}

async function cmdGate(gate: string, dir: string, cmd: string, args: string[], env: Record<string, string> = {}, timeoutMs = 5 * 60_000) {
  const r = await run(cmd, args, { cwd: dir, env, timeoutMs });
  return { gate, ok: r.code === 0, output: tail(r.output, 8000), ms: r.ms } satisfies GateResult;
}

export async function validate(dir: string, opts: { packageStage?: string; region?: string; env?: Pick<Env, "AWS_ACCESS_KEY_ID" | "AWS_SECRET_ACCESS_KEY"> } = {}): Promise<GateResult[]> {
  const results: GateResult[] = staticChecks(dir);
  // Fail fast: no point type-checking code that broke the contract.
  if (results.some((r) => !r.ok)) return results;

  for (const [gate, args] of [
    ["typecheck", ["tsc", "--noEmit"]],
    ["tests", ["vitest", "run"]],
  ] as const) {
    const r = await cmdGate(gate, dir, "npx", [...args]);
    results.push(r);
    log(`gate ${gate}: ${r.ok ? "ok" : "FAILED"} (${r.ms}ms)`);
    if (!r.ok) return results;
  }

  const build = await cmdGate("bundle", dir, "node", ["build.mjs"]);
  if (build.ok) {
    const size = statSync(join(dir, "dist/handler.mjs")).size;
    if (size > 2_000_000) Object.assign(build, { ok: false, output: `bundle is ${size} bytes (> 2MB limit)` });
    else build.output = `dist/handler.mjs ${size} bytes`;
  }
  results.push(build);
  log(`gate bundle: ${build.ok ? "ok" : "FAILED"}`);
  if (!build.ok) return results;

  const pkg = await cmdGate("package", dir, "npx", [
    "osls",
    "package",
    "--stage",
    opts.packageStage ?? "dev",
    "--region",
    opts.region ?? "us-east-1",
  ], {
    // `package` needs no real credentials; dummy ones stop the SDK from searching for a profile.
    AWS_ACCESS_KEY_ID: opts.env?.AWS_ACCESS_KEY_ID ?? "AKIAPACKAGEONLY0000",
    AWS_SECRET_ACCESS_KEY: opts.env?.AWS_SECRET_ACCESS_KEY ?? "package-only",
  });
  results.push(pkg);
  log(`gate package: ${pkg.ok ? "ok" : "FAILED"}`);
  return results;
}

export const passed = (rs: GateResult[]) => rs.every((r) => r.ok);

export function failureReport(rs: GateResult[]) {
  return rs
    .filter((r) => !r.ok)
    .map((r) => `## Gate failed: ${r.gate}\n\n\`\`\`\n${r.output || "(no output)"}\n\`\`\``)
    .join("\n\n");
}
