// Post-deploy smoke tests against a live URL, driven by the app's manifest.
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { log } from "./exec.js";

export interface SmokeResult {
  name: string;
  ok: boolean;
  detail: string;
}

interface SmokeCheck {
  name: string;
  method: string;
  path: string;
  auth?: "public" | "user";
  body?: unknown;
  expectStatus: number;
  expectBodyIncludes?: string;
}

export async function loadManifest(dir: string): Promise<{ activationEvent: string; smoke: SmokeCheck[] }> {
  const mod = await import(`${pathToFileURL(join(dir, "src/app/manifest.ts")).href}?t=${Date.now()}`);
  return mod.manifest;
}

async function req(base: string, method: string, path: string, body?: unknown, token?: string) {
  const headers: Record<string, string> = { "content-type": "application/json", "user-agent": "mvp-factory-smoke" };
  if (token) headers.authorization = `Bearer ${token}`;
  const r = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, text: await r.text() };
}

export async function verify(base: string, dir: string, fetchImpl?: typeof fetch): Promise<SmokeResult[]> {
  if (fetchImpl) globalThis.fetch = fetchImpl;
  const results: SmokeResult[] = [];
  const check = (name: string, ok: boolean, detail: string) => {
    results.push({ name, ok, detail });
    log(`smoke ${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` — ${detail}`}`);
  };

  // Health, with retries for cold starts / API propagation.
  let health = { status: 0, text: "" };
  for (let i = 0; i < 6; i++) {
    health = await req(base, "GET", "/api/health").catch((e) => ({ status: 0, text: String(e) }));
    if (health.status === 200) break;
    await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
  }
  check("health", health.status === 200, `${health.status} ${health.text.slice(0, 200)}`);
  if (health.status !== 200) return results;

  // Synthetic user: excluded from metrics (@smoke.invalid) and deleted at the end.
  const email = `factory-${Date.now()}-${randomBytes(3).toString("hex")}@smoke.invalid`;
  const su = await req(base, "POST", "/api/auth/signup", { email, password: randomBytes(12).toString("hex") });
  check("signup", su.status === 201, `${su.status} ${su.text.slice(0, 200)}`);
  const token = su.status === 201 ? (JSON.parse(su.text).token as string) : undefined;

  const manifest = await loadManifest(dir);
  for (const c of manifest.smoke) {
    if (c.auth === "user" && !token) {
      check(c.name, false, "skipped: no test user");
      continue;
    }
    const r = await req(base, c.method, c.path, c.body, c.auth === "user" ? token : undefined).catch((e) => ({
      status: 0,
      text: String(e),
    }));
    const ok = r.status === c.expectStatus && (!c.expectBodyIncludes || r.text.includes(c.expectBodyIncludes));
    check(c.name, ok, `expected ${c.expectStatus}${c.expectBodyIncludes ? ` containing "${c.expectBodyIncludes}"` : ""}, got ${r.status} ${r.text.slice(0, 200)}`);
  }

  if (token) {
    const del = await req(base, "DELETE", "/api/auth/me", undefined, token);
    check("cleanup test user", del.status === 200, `${del.status}`);
  }
  return results;
}
