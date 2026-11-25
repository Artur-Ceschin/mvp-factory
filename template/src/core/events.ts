// Product analytics stored in the app's own table, read by the factory's scorer.
// Daily counters: pk=METRIC#<yyyy-mm-dd>, sk=<event>. Daily actives: pk=DAU#<day>, sk=<userId>.
// Per-user first-time markers: pk=USER#<id>, sk=FIRST#<event> (for unique activation counts).
// CORE FILE — generated apps must not edit anything under src/core.
import { ConflictError, db } from "./db.js";
import { json, type Router } from "./http.js";

const EVENT_RE = /^[a-z][a-z0-9_]{1,39}$/;
const day = (d = new Date()) => d.toISOString().slice(0, 10);

/** Synthetic users created by the factory's smoke tests have ids starting with this prefix. */
export const SMOKE_PREFIX = "smoke-";

export async function track(event: string, userId?: string, props: Record<string, unknown> = {}) {
  if (!EVENT_RE.test(event)) throw new Error(`Invalid event name: ${event}`);
  if (userId?.startsWith(SMOKE_PREFIX)) return; // keep smoke traffic out of product metrics
  const d = day();
  const ops: Promise<unknown>[] = [db().increment(`METRIC#${d}`, event, { count: 1 })];
  if (userId) {
    ops.push(db().put({ pk: `DAU#${d}`, sk: userId, ttl: ttlDays(120) }));
    ops.push(
      db()
        .put({ pk: `USER#${userId}`, sk: `FIRST#${event}`, at: new Date().toISOString(), props }, { ifNotExists: true })
        .then(() => db().increment(`METRIC#${d}`, `unique_${event}`.slice(0, 40), { count: 1 }))
        .catch((e) => {
          if (!(e instanceof ConflictError)) throw e;
        }),
    );
  }
  await Promise.all(ops);
}

const ttlDays = (n: number) => Math.floor(Date.now() / 1000) + n * 86400;

export interface DailyMetrics {
  day: string;
  events: Record<string, number>;
  dau: number;
}

export async function readMetrics(days: number): Promise<DailyMetrics[]> {
  const out: DailyMetrics[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = day(new Date(Date.now() - i * 86400_000));
    const [rows, dau] = await Promise.all([db().query(`METRIC#${d}`), db().query(`DAU#${d}`)]);
    out.push({
      day: d,
      events: Object.fromEntries(rows.map((r) => [r.sk, Number(r.count ?? 0)])),
      dau: dau.length,
    });
  }
  return out;
}

export function registerEventRoutes(r: Router) {
  // Public: the browser SDK reports page views and UI events. Server-side events use track().
  r.post("/api/events", async (req) => {
    const name = String(req.body?.event ?? "");
    if (!EVENT_RE.test(name) || !name.startsWith("ui_") && name !== "pageview")
      return json({ ok: false, error: "client events must be 'pageview' or start with 'ui_'" }, 400);
    await track(name, req.user?.id);
    return json({ ok: true });
  });

  // Admin: consumed by the factory scorer.
  r.get(
    "/api/_metrics",
    async (req) => {
      const days = Math.min(Math.max(Number(req.query.days ?? 14) || 14, 1), 90);
      return json({ days: await readMetrics(days) });
    },
    "admin",
  );
}
