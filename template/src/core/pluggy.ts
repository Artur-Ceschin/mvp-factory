// Pluggy (Brazilian Open Finance aggregator) client. Server-side only: the client secret never reaches the browser.
// Flow: POST /api/pluggy/connect-token -> browser opens Pluggy Connect widget -> widget returns itemId
// -> app stores itemId for the user -> server lists accounts/transactions with listAccounts/listTransactions.
// Docs: https://docs.pluggy.ai (API key valid 2h, connect token 30min, transactions via cursor on /v2).
// CORE FILE — generated apps must not edit anything under src/core.
import { HttpError } from "./http.js";
import { t } from "./i18n.js";
import { secret } from "./secrets.js";

const BASE = "https://api.pluggy.ai";
let apiKey: { value: string; exp: number } | undefined;

export interface PluggyAccount {
  id: string;
  name: string;
  type: string;
  subtype?: string;
  balance: number;
  currencyCode: string;
}

export interface PluggyTransaction {
  id: string;
  description: string;
  amount: number;
  date: string;
  category?: string | null;
  type: "DEBIT" | "CREDIT";
  status?: "PENDING" | "POSTED";
  currencyCode?: string;
  merchant?: { name?: string } | null;
}

export async function pluggyEnabled() {
  return Boolean((await secret("PLUGGY_CLIENT_ID")) && (await secret("PLUGGY_CLIENT_SECRET")));
}

async function key(): Promise<string> {
  if (apiKey && apiKey.exp > Date.now()) return apiKey.value;
  const clientId = await secret("PLUGGY_CLIENT_ID");
  const clientSecret = await secret("PLUGGY_CLIENT_SECRET");
  if (!clientId || !clientSecret) throw new HttpError(503, t("pluggy_disabled"), "pluggy_disabled");
  const r = await fetch(`${BASE}/auth`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ clientId, clientSecret }),
  });
  if (!r.ok) throw new HttpError(502, t("pluggy_auth"), "pluggy_auth");
  const data = (await r.json()) as { apiKey: string };
  apiKey = { value: data.apiKey, exp: Date.now() + 100 * 60_000 }; // valid 2h; refresh early
  return data.apiKey;
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: { "X-API-KEY": await key(), "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!r.ok) throw new HttpError(502, `${t("pluggy_error")} (${method} ${path.split("?")[0]}: ${r.status})`, "pluggy_error");
  return (await r.json()) as T;
}

/** Short-lived token for the Pluggy Connect widget. Pass itemId to update an existing connection. */
export async function createConnectToken(opts: { itemId?: string; clientUserId?: string } = {}) {
  const body: Record<string, unknown> = {};
  if (opts.itemId) body.itemId = opts.itemId;
  if (opts.clientUserId) body.options = { clientUserId: opts.clientUserId };
  return (await call<{ accessToken: string }>("POST", "/connect_token", body)).accessToken;
}

export async function listAccounts(itemId: string) {
  return (await call<{ results: PluggyAccount[] }>("GET", `/accounts?itemId=${encodeURIComponent(itemId)}`)).results;
}

/** All transactions for an account since dateFrom (YYYY-MM-DD), following the v2 cursor. */
export async function listTransactions(accountId: string, dateFrom?: string, maxPages = 10) {
  const out: PluggyTransaction[] = [];
  let after: string | null | undefined;
  for (let page = 0; page < maxPages; page++) {
    const qs = new URLSearchParams({ accountId });
    if (dateFrom) qs.set("dateFrom", dateFrom);
    if (after) qs.set("after", after);
    const r = await call<{ results: PluggyTransaction[]; next?: string | null }>("GET", `/v2/transactions?${qs}`);
    out.push(...r.results);
    after = r.next ? new URL(r.next, BASE).searchParams.get("after") ?? r.next : null;
    if (!after) break;
  }
  return out;
}

export async function deleteItem(itemId: string) {
  await call("DELETE", `/items/${encodeURIComponent(itemId)}`);
}
