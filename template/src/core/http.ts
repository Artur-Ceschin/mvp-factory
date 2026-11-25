// Tiny HTTP layer: request/response types and a router with :params and auth levels.
// CORE FILE — generated apps must not edit anything under src/core.

export type AuthLevel = "public" | "user" | "pro" | "admin";

export interface User {
  id: string;
  email: string;
  plan: "free" | "pro";
  createdAt: string;
}

export interface Req {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  params: Record<string, string>;
  rawBody: string;
  body: any;
  user?: User;
}

export interface Res {
  status: number;
  headers?: Record<string, string>;
  body: string;
}

export class HttpError extends Error {
  constructor(public status: number, message: string, public code = "error") {
    super(message);
  }
}

export const json = (data: unknown, status = 200): Res => ({
  status,
  headers: { "content-type": "application/json; charset=utf-8" },
  body: JSON.stringify(data),
});

export const html = (body: string, status = 200): Res => ({
  status,
  headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" },
  body,
});

export const asset = (body: string, contentType: string): Res => ({
  status: 200,
  headers: { "content-type": contentType, "cache-control": "public, max-age=300" },
  body,
});

export type Handler = (req: Req) => Promise<Res> | Res;

interface Route {
  method: string;
  parts: string[];
  auth: AuthLevel;
  handler: Handler;
}

export class Router {
  private routes: Route[] = [];

  add(method: string, pattern: string, handler: Handler, auth: AuthLevel = "public") {
    this.routes.push({ method: method.toUpperCase(), parts: split(pattern), auth, handler });
    return this;
  }
  get(p: string, h: Handler, a?: AuthLevel) { return this.add("GET", p, h, a); }
  post(p: string, h: Handler, a?: AuthLevel) { return this.add("POST", p, h, a); }
  put(p: string, h: Handler, a?: AuthLevel) { return this.add("PUT", p, h, a); }
  patch(p: string, h: Handler, a?: AuthLevel) { return this.add("PATCH", p, h, a); }
  delete(p: string, h: Handler, a?: AuthLevel) { return this.add("DELETE", p, h, a); }

  match(method: string, path: string): { route: Route; params: Record<string, string> } | undefined {
    const parts = split(path);
    for (const route of this.routes) {
      if (route.method !== method.toUpperCase() || route.parts.length !== parts.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < parts.length; i++) {
        const want = route.parts[i]!;
        const got = parts[i]!;
        if (want.startsWith(":")) params[want.slice(1)] = decodeURIComponent(got);
        else if (want !== got) { ok = false; break; }
      }
      if (ok) return { route, params };
    }
    return undefined;
  }

  list() {
    return this.routes.map((r) => `${r.method} /${r.parts.join("/")} [${r.auth}]`);
  }
}

function split(path: string) {
  return path.split("?")[0]!.split("/").filter(Boolean);
}

/** Validates a JSON body against a simple field spec; throws 400 on failure. */
export function requireFields<T extends Record<string, "string" | "number" | "boolean" | "array" | "object">>(
  body: any,
  spec: T,
): { [K in keyof T]: any } {
  if (!body || typeof body !== "object") throw new HttpError(400, "JSON body required", "bad_request");
  for (const [key, type] of Object.entries(spec)) {
    const v = body[key];
    const actual = Array.isArray(v) ? "array" : typeof v;
    if (actual !== type) throw new HttpError(400, `Field '${key}' must be ${type}`, "bad_request");
  }
  return body;
}
