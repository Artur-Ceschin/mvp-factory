// Core behaviour every generated app must keep. CORE FILE — do not edit.
import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { setPlan } from "../src/core/auth.js";
import { verifyStripeSignature } from "../src/core/billing.js";
import { manifest } from "../src/app/manifest.js";
import { handler, router } from "../src/core/handler.js";
import { call, resetDb, signup } from "./helpers.js";

beforeEach(resetDb);

describe("core", () => {
  it("health", async () => {
    const r = await call("GET", "/api/health");
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
  });

  it("serves the web app, sdk and css", async () => {
    const home = await call("GET", "/");
    expect(home.status).toBe(200);
    expect(home.raw).toContain("/_sdk.js");
    expect(home.raw).not.toMatch(/\{\{(APP_NAME|LANG|PRICE)\}\}/);
    expect((await call("GET", "/_sdk.js")).raw).toContain("window.App");
    expect((await call("GET", "/_base.css")).status).toBe(200);
    expect((await call("GET", "/some/deep/link")).status).toBe(200);
  });

  it("serves the app theme and links the design system", async () => {
    const theme = await call("GET", "/_theme.css");
    expect(theme.status).toBe(200);
    expect(theme.raw).toContain("--color-primary");
    const home = (await call("GET", "/")).raw;
    for (const href of ["/_base.css", "/_theme.css", "https://fonts.bunny.net/"]) expect(home).toContain(href);
  });

  it("sends a Content-Security-Policy that only allows Bunny Fonts and Pluggy", async () => {
    const res = await handler({
      rawPath: "/",
      headers: { host: "test.local" },
      isBase64Encoded: false,
      requestContext: { http: { method: "GET" } },
    } as unknown as Parameters<typeof handler>[0]);
    const headers = (res as { headers: Record<string, string> }).headers;
    const csp = headers["content-security-policy"]!;
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("font-src https://fonts.bunny.net");
    expect(csp).toContain("style-src 'self' 'unsafe-inline' https://fonts.bunny.net");
    expect(csp).toContain("script-src 'self' 'unsafe-inline' https://cdn.pluggy.ai");
    expect(csp).toContain("frame-src https://*.pluggy.ai");
    expect(headers["x-content-type-options"]).toBe("nosniff");
  });

  it("unknown api route is 404 json", async () => {
    const r = await call("GET", "/api/does-not-exist");
    expect(r.status).toBe(404);
  });

  it("signup, login, me", async () => {
    const { token, user } = await signup("a@test.local");
    expect(user.plan).toBe("free");
    expect((await call("GET", "/api/auth/me", { token })).body.user.email).toBe("a@test.local");
    expect((await call("POST", "/api/auth/signup", { body: { email: "a@test.local", password: "password123" } })).status).toBe(409);
    expect((await call("POST", "/api/auth/login", { body: { email: "a@test.local", password: "wrong-pass" } })).status).toBe(401);
    expect((await call("POST", "/api/auth/login", { body: { email: "A@test.local", password: "password123" } })).status).toBe(200);
    expect((await call("GET", "/api/auth/me")).status).toBe(401);
    expect((await call("GET", "/api/auth/me", { token: token + "x" })).status).toBe(401);
  });

  it("deletes the account and all user data (LGPD)", async () => {
    const { token, user } = await signup("del@test.local");
    const r = await call("DELETE", "/api/auth/me", { token });
    expect(r.status).toBe(200);
    expect((await call("GET", "/api/auth/me", { token })).status).toBe(401);
    expect((await call("POST", "/api/auth/signup", { body: { email: "del@test.local", password: "password123" } })).status).toBe(201);
    expect(user.id).toBeTruthy();
  });

  it("rate limits failed logins", async () => {
    await signup("b@test.local");
    for (let i = 0; i < 10; i++) await call("POST", "/api/auth/login", { body: { email: "b@test.local", password: "nope-nope" } });
    expect((await call("POST", "/api/auth/login", { body: { email: "b@test.local", password: "password123" } })).status).toBe(429);
  });

  it("metrics are admin-only and count events", async () => {
    await signup();
    await call("POST", "/api/events", { body: { event: "pageview" } });
    expect((await call("POST", "/api/events", { body: { event: "signup" } })).status).toBe(400);
    expect((await call("GET", "/api/_metrics")).status).toBe(403);
    const r = await call("GET", "/api/_metrics?days=1", { headers: { "x-admin-token": "test-admin" } });
    expect(r.status).toBe(200);
    const today = r.body.days[0];
    expect(today.events.signup).toBe(1);
    expect(today.events.unique_signup).toBe(1);
    expect(today.events.pageview).toBe(1);
    expect(today.dau).toBe(1);
  });

  it("billing is disabled without stripe key", async () => {
    const { token } = await signup();
    expect((await call("POST", "/api/billing/checkout", { token, body: {} })).status).toBe(503);
  });

  it("verifies stripe signatures", () => {
    const payload = '{"id":"evt_1"}';
    const t = Math.floor(Date.now() / 1000);
    const sig = createHmac("sha256", "whsec_x").update(`${t}.${payload}`).digest("hex");
    expect(verifyStripeSignature(payload, `t=${t},v1=${sig}`, "whsec_x")).toBe(true);
    expect(verifyStripeSignature(payload, `t=${t},v1=${sig}`, "whsec_y")).toBe(false);
    expect(verifyStripeSignature(payload, `t=${t - 1000},v1=${sig}`, "whsec_x")).toBe(false);
  });

  it("pro routes return 402 for free users and 200 for pro", async () => {
    const pro = router.list().find((r) => r.endsWith("[pro]"));
    if (!pro) return; // app has no paid-only route
    const [method, path] = pro.split(" ") as [string, string];
    if (path.includes(":")) return;
    const { token, user } = await signup();
    expect((await call(method, path, { token, body: method === "GET" ? undefined : {} })).status).toBe(402);
    await setPlan(user.id, "pro");
    expect((await call(method, path, { token, body: method === "GET" ? undefined : {} })).status).not.toBe(402);
  });
});

describe("app manifest", () => {
  it("has a valid activation event and smoke checks", () => {
    expect(manifest.activationEvent).toMatch(/^[a-z][a-z0-9_]{1,39}$/);
    expect(manifest.smoke.length).toBeGreaterThanOrEqual(3);
  });

  it("smoke checks pass in-process", async () => {
    const { token } = await signup();
    for (const c of manifest.smoke) {
      const r = await call(c.method, c.path, { token: c.auth === "user" ? token : undefined, body: c.body });
      expect(r.status, `${c.name}: ${r.raw.slice(0, 200)}`).toBe(c.expectStatus);
      if (c.expectBodyIncludes) expect(r.raw, c.name).toContain(c.expectBodyIncludes);
    }
  });

  it("activation event is tracked by some app route", async () => {
    const { readFileSync, readdirSync } = await import("node:fs");
    const walk = (d: string): string[] =>
      readdirSync(d, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(`${d}/${e.name}`) : e.name.endsWith(".ts") ? [`${d}/${e.name}`] : [],
      );
    const src = walk("src/app").map((f) => readFileSync(f, "utf8")).join("\n");
    expect(src).toContain(`"${manifest.activationEvent}"`);
  });
});
