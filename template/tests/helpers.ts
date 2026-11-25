// Test helpers for calling the app in-process. CORE FILE — do not edit.
import { memoryDb } from "../src/core/db.js";
import { handle } from "../src/core/handler.js";

export function resetDb() {
  memoryDb.reset();
}

export async function call(
  method: string,
  path: string,
  opts: { body?: unknown; token?: string; headers?: Record<string, string>; rawBody?: string } = {},
) {
  const [p, qs] = path.split("?");
  const headers: Record<string, string> = { "content-type": "application/json", host: "test.local", ...opts.headers };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  const rawBody = opts.rawBody ?? (opts.body === undefined ? "" : JSON.stringify(opts.body));
  const res = await handle({
    method,
    path: p!,
    query: Object.fromEntries(new URLSearchParams(qs ?? "")),
    headers,
    params: {},
    rawBody,
    body: rawBody ? safeJson(rawBody) : undefined,
  });
  return { status: res.status, body: safeJson(res.body) ?? res.body, raw: res.body };
}

function safeJson(s: string) {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

let n = 0;
export async function signup(email = `user${++n}-${Date.now()}@test.local`) {
  const r = await call("POST", "/api/auth/signup", { body: { email, password: "password123" } });
  if (r.status !== 201) throw new Error(`signup failed: ${r.raw}`);
  return { token: r.body.token as string, user: r.body.user as { id: string; email: string; plan: string } };
}
