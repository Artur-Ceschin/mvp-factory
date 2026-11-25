// Turns live product metrics into a scorecard and a keep/iterate/kill decision.
import type { Config } from "./config.js";
import type { Decision, Scorecard } from "./registry.js";

export interface DailyMetrics {
  day: string;
  events: Record<string, number>;
  dau: number;
}

export async function fetchMetrics(url: string, adminToken: string, days: number): Promise<DailyMetrics[]> {
  const r = await fetch(`${url}/api/_metrics?days=${days}`, { headers: { "x-admin-token": adminToken } });
  if (!r.ok) throw new Error(`metrics ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return ((await r.json()) as { days: DailyMetrics[] }).days;
}

const sum = (days: DailyMetrics[], ev: string) => days.reduce((n, d) => n + (d.events[ev] ?? 0), 0);
const rate = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 1000) / 1000 : 0);

export function scorecard(
  days: DailyMetrics[],
  activationEvent: string,
  cfg: Config["score"],
  liveSince: string | undefined,
  now = new Date(),
): Scorecard {
  const visitors = sum(days, "pageview");
  const signups = sum(days, "unique_signup");
  const activated = sum(days, `unique_${activationEvent}`.slice(0, 40));
  const paid = sum(days, "subscription_activated");
  const canceled = sum(days, "subscription_canceled");
  const dauAvg = days.length ? Math.round((days.reduce((n, d) => n + d.dau, 0) / days.length) * 10) / 10 : 0;
  const signupRate = rate(signups, visitors);
  const activationRate = rate(activated, signups);
  const paidRate = rate(paid, signups);
  const daysLive = liveSince ? (now.getTime() - new Date(liveSince).getTime()) / 86400_000 : 0;

  let decision: Decision;
  let reason: string;
  if (paid >= cfg.scaleIfPaidAtLeast) {
    decision = "scale";
    reason = `${paid} paying signups in ${days.length}d — people pay for this; keep improving it.`;
  } else if (daysLive < cfg.minDaysLive) {
    decision = "warming-up";
    reason = `live for ${daysLive.toFixed(1)}d (< ${cfg.minDaysLive}d) — too early to judge.`;
  } else if (visitors < cfg.minVisitors) {
    decision = "needs-traffic";
    reason = `${visitors} visitors (< ${cfg.minVisitors}) — not enough traffic to validate; send users before judging.`;
  } else if (signupRate >= cfg.minSignupRate) {
    decision = "iterate";
    reason = `signup rate ${(signupRate * 100).toFixed(1)}% shows interest but ${paid} paid — work on activation/conversion.`;
  } else {
    decision = "kill-candidate";
    reason = `${visitors} visitors, signup rate ${(signupRate * 100).toFixed(1)}% (< ${(cfg.minSignupRate * 100).toFixed(1)}%) and ${paid} paid.`;
  }
  return {
    at: now.toISOString(),
    windowDays: days.length,
    visitors,
    signups,
    activated,
    paid,
    canceled,
    dauAvg,
    signupRate,
    activationRate,
    paidRate,
    decision,
    reason,
  };
}

/** What the iterate prompt should focus on, from the weakest funnel step. */
export function iterationFocus(s: Scorecard, minSignupRate: number) {
  if (s.signupRate < minSignupRate)
    return "Weakest step: visit → signup. Sharpen the landing: headline, concrete outcome, social-proof-free credibility (demo, example output), and a lower-friction first step.";
  if (s.activationRate < 0.4)
    return "Weakest step: signup → activation. Shorten time-to-value: guided first run, sensible defaults, sample data, fewer fields.";
  return "Weakest step: activation → paid. Make the Pro value visible at the moment of need: show what Pro unlocks inline, tune free-tier limits, add a clear upgrade moment.";
}
