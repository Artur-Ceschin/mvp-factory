// Lambda entry point: one function serves the API (/api/*) and the single-page web app.
// CORE FILE — generated apps must not edit anything under src/core.
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { registerAppRoutes } from "../app/routes.js";
import indexHtml from "../app/web/index.html";
import { authenticate, registerAuthRoutes } from "./auth.js";
import { registerBillingRoutes } from "./billing.js";
import { registerEventRoutes } from "./events.js";
import { asset, html, HttpError, json, Router, type Req, type Res } from "./http.js";
import { secret } from "./secrets.js";
import baseCss from "./web/base.css";
import sdkJs from "./web/sdk.txt";

export const router = new Router();
router.get("/api/health", () =>
  json({ ok: true, app: process.env.APP_SLUG ?? "dev", stage: process.env.STAGE ?? "dev", version: process.env.APP_VERSION ?? "0" }),
);
registerAuthRoutes(router);
registerBillingRoutes(router);
registerEventRoutes(router);
registerAppRoutes(router);

const page = () =>
  indexHtml
    .replaceAll("{{APP_NAME}}", process.env.APP_NAME ?? "App")
    .replaceAll("{{PRICE}}", formatPrice());

function formatPrice() {
  const cents = Number(process.env.PRICE_CENTS ?? 0);
  const cur = (process.env.PRICE_CURRENCY ?? "brl").toUpperCase();
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: cur }).format(cents / 100);
}

export async function handle(req: Req): Promise<Res> {
  try {
    if (req.method === "GET" && req.path === "/_sdk.js") return asset(sdkJs, "text/javascript; charset=utf-8");
    if (req.method === "GET" && req.path === "/_base.css") return asset(baseCss, "text/css; charset=utf-8");

    const m = router.match(req.method, req.path);
    if (!m) {
      if (req.path.startsWith("/api/")) throw new HttpError(404, "Not found", "not_found");
      if (req.method === "GET") return html(page()); // SPA fallback
      throw new HttpError(405, "Method not allowed", "method_not_allowed");
    }
    req.params = m.params;
    req.user = await authenticate(req).catch(() => undefined);

    switch (m.route.auth) {
      case "user":
        if (!req.user) throw new HttpError(401, "Faça login para continuar", "unauthorized");
        break;
      case "pro":
        if (!req.user) throw new HttpError(401, "Faça login para continuar", "unauthorized");
        if (req.user.plan !== "pro") throw new HttpError(402, "Recurso do plano Pro", "payment_required");
        break;
      case "admin": {
        const token = await secret("ADMIN_TOKEN");
        if (!token || req.headers["x-admin-token"] !== token) throw new HttpError(403, "Forbidden", "forbidden");
        break;
      }
    }
    return await m.route.handler(req);
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.code, message: e.message }, e.status);
    console.error(JSON.stringify({ level: "error", path: req.path, err: String((e as Error)?.stack ?? e) }));
    return json({ error: "internal", message: "Erro interno" }, 500);
  }
}

export function toReq(event: APIGatewayProxyEventV2): Req {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(event.headers ?? {})) if (v !== undefined) headers[k.toLowerCase()] = v;
  const rawBody = event.body ? (event.isBase64Encoded ? Buffer.from(event.body, "base64").toString() : event.body) : "";
  let body: unknown;
  if (rawBody && (headers["content-type"] ?? "").includes("application/json")) {
    try {
      body = JSON.parse(rawBody);
    } catch {
      body = undefined;
    }
  }
  return {
    method: event.requestContext.http.method,
    path: event.rawPath,
    query: (event.queryStringParameters ?? {}) as Record<string, string>,
    headers,
    params: {},
    rawBody,
    body,
  };
}

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const res = await handle(toReq(event));
  return {
    statusCode: res.status,
    headers: {
      "x-content-type-options": "nosniff",
      "referrer-policy": "strict-origin-when-cross-origin",
      ...res.headers,
    },
    body: res.body,
  };
}
