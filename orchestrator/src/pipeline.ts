// The factory loop: score live apps → iterate the promising ones → build new ideas → ship.
import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Builder, BuildMode, BuildTask } from "./builder.js";
import type { Config } from "./config.js";
import { designLoop, polishVars, type DesignReviewer } from "./design.js";
import type { Env } from "./env.js";
import { deploy, getSecret, remove } from "./deploy.js";
import { log } from "./exec.js";
import { failureReport, passed, validate, type GateResult } from "./gates.js";
import { loadIdea, loadIdeas, type Idea } from "./ideas.js";
import { readRegistry, updateApp, type Scorecard } from "./registry.js";
import { appDir, scaffold, writeAppMeta } from "./scaffold.js";
import { fetchMetrics, iterationFocus, scorecard, type DailyMetrics } from "./score.js";
import { verify, type SmokeResult } from "./verify.js";

export interface Ctx {
  cfg: Config;
  env: Env;
  builder: Builder;
  /** Design review after the gates pass; undefined skips it (dry runs, no ANTHROPIC_API_KEY, design.enabled: false). */
  reviewer?: DesignReviewer;
  /** Overrides the validation gates (tests). */
  validate?: (dir: string) => Promise<GateResult[]>;
  /** Skip AWS entirely (no deploy, no scoring). */
  deploy: boolean;
  version: string;
}

export interface StepReport {
  slug: string;
  step: "build" | "iterate" | "ship" | "score" | "kill";
  ok: boolean;
  detail: string;
}

/**
 * Runs the agent, then the gates (feeding failures back up to maxRepairAttempts), then — when a
 * design reviewer is configured — the design review with up to maxPolishAttempts polish sessions.
 */
async function buildLoop(ctx: Ctx, idea: Idea, mode: BuildMode, vars: Record<string, string> = {}) {
  const dir = appDir(idea.slug);
  const gatesOf = ctx.validate ?? ((d: string) => validate(d, { region: ctx.cfg.aws.region, env: ctx.env }));
  let cost = 0;
  let attempts = 0;
  const agent = async (task: BuildTask) => {
    attempts++;
    const r = await ctx.builder.run(task);
    cost += r.costUsd;
    return r;
  };
  const gateLoop = async () => {
    let gates = await gatesOf(dir);
    for (let repair = 1; !passed(gates) && repair <= ctx.cfg.builder.maxRepairAttempts; repair++) {
      log(`gates failed (${failedGates(gates)}); repair attempt ${repair}`);
      await agent({ dir, idea, mode: "repair", vars: { FAILURES: failureReport(gates) } });
      gates = await gatesOf(dir);
    }
    return gates;
  };

  const first = await agent({ dir, idea, mode, vars });
  log(`agent (${mode}): ${first.summary.split("\n")[0]?.slice(0, 160)}`);
  let gates = await gateLoop();
  const result = (ok: boolean, failure: string, designScores: number[] = []) =>
    ({ ok, gates, cost, attempts, summary: first.summary, failure, designScores });
  if (!passed(gates)) return result(false, failedGates(gates));
  if (!ctx.reviewer) return result(true, "");

  const design = await designLoop({
    design: ctx.cfg.design,
    review: () => ctx.reviewer!.review(dir, idea),
    polish: async (last) => {
      await agent({ dir, idea, mode: "polish", vars: polishVars(dir, last, ctx.cfg.design.minScore) });
    },
    revalidate: async () => passed((gates = await gateLoop())),
  });
  return result(design.ok, design.ok ? "" : design.reason, design.scores);
}

const failedGates = (gates: GateResult[]) => gates.filter((g) => !g.ok).map((g) => g.gate).join(", ");
const designNote = (scores: number[]) => (scores.length ? `, design ${scores.at(-1)}/10` : "");
const designFields = (scores: number[]) => (scores.length ? { designScore: scores.at(-1)!, designScores: scores } : {});

export async function buildApp(ctx: Ctx, idea: Idea, opts: { force?: boolean } = {}): Promise<StepReport> {
  log(`building ${idea.slug}`);
  updateApp(idea.slug, (r) => (r.status = "building"));
  scaffold(idea, ctx.cfg, { force: opts.force });
  const r = await buildLoop(ctx, idea, "build");
  updateApp(idea.slug, (rec) => {
    rec.status = r.ok ? (rec.status === "live" ? "live" : "built") : "build-failed";
    rec.builds.push({ at: new Date().toISOString(), kind: "build", ok: r.ok, costUsd: r.cost, attempts: r.attempts, note: r.summary.slice(0, 500), ...designFields(r.designScores) });
  });
  return {
    slug: idea.slug,
    step: "build",
    ok: r.ok,
    detail: r.ok
      ? `built in ${r.attempts} attempt(s), $${r.cost.toFixed(2)}${designNote(r.designScores)}`
      : `failed after ${r.attempts} attempt(s): ${r.failure}`,
  };
}

/** Improves a live app from its metrics. On failure the previous app code is restored. */
export async function iterateApp(ctx: Ctx, idea: Idea, score: Scorecard, daily: DailyMetrics[]): Promise<StepReport> {
  const dir = appDir(idea.slug);
  const backup = mkdtempSync(join(tmpdir(), `factory-${idea.slug}-`));
  for (const p of ["src/app", "tests"]) cpSync(join(dir, p), join(backup, p), { recursive: true });
  const r = await buildLoop(ctx, idea, "iterate", {
    WINDOW: String(score.windowDays),
    SCORECARD: scoreTable([[idea.slug, score]]),
    DAILY: JSON.stringify(daily, null, 1),
    DECISION: `${score.decision} — ${score.reason}`,
    FOCUS: iterationFocus(score, ctx.cfg.score.minSignupRate),
  });
  if (!r.ok) {
    for (const p of ["src/app", "tests"]) {
      rmSync(join(dir, p), { recursive: true, force: true });
      cpSync(join(backup, p), join(dir, p), { recursive: true });
    }
    log(`iteration failed; restored previous version of ${idea.slug}`);
  }
  rmSync(backup, { recursive: true, force: true });
  updateApp(idea.slug, (rec) =>
    rec.builds.push({ at: new Date().toISOString(), kind: "iterate", ok: r.ok, costUsd: r.cost, attempts: r.attempts, note: r.summary.slice(0, 500), ...designFields(r.designScores) }),
  );
  return {
    slug: idea.slug,
    step: "iterate",
    ok: r.ok,
    detail: r.ok ? `iteration validated ($${r.cost.toFixed(2)}${designNote(r.designScores)})` : `iteration failed (${r.failure}); reverted`,
  };
}

/** Deploys every stage in order; stops at the first stage whose smoke tests fail. */
export async function shipApp(ctx: Ctx, idea: Idea): Promise<StepReport> {
  const dir = appDir(idea.slug);
  writeAppMeta(idea, ctx.cfg);
  const results: Record<string, SmokeResult[]> = {};
  for (const stage of ctx.cfg.aws.stages) {
    try {
      const url = await deploy(ctx.cfg, ctx.env, idea, dir, stage, ctx.version);
      updateApp(idea.slug, (r) => (r.urls[stage] = url));
      results[stage] = await verify(url, dir);
    } catch (e) {
      results[stage] = [{ name: "deploy", ok: false, detail: (e as Error).message.slice(-1500) }];
    }
    if (!results[stage]!.every((s) => s.ok)) {
      updateApp(idea.slug, (r) => (r.status = r.status === "live" ? "live" : "deploy-failed"));
      const failed = results[stage]!.filter((s) => !s.ok).map((s) => `${s.name}: ${s.detail}`).join("; ");
      return { slug: idea.slug, step: "ship", ok: false, detail: `${stage} failed — ${failed.slice(0, 600)}` };
    }
  }
  const rec = updateApp(idea.slug, (r) => {
    r.status = "live";
    r.liveSince ??= new Date().toISOString();
    r.version = ctx.version;
  });
  return { slug: idea.slug, step: "ship", ok: true, detail: Object.entries(rec.urls).map(([s, u]) => `${s}: ${u}`).join(" · ") };
}

const prodStage = (cfg: Config) => cfg.aws.stages[cfg.aws.stages.length - 1]!;

export async function scoreApp(ctx: Ctx, idea: Idea) {
  const rec = readRegistry()[idea.slug];
  const stage = prodStage(ctx.cfg);
  const url = rec?.urls[stage];
  if (!rec || rec.status !== "live" || !url) throw new Error(`${idea.slug} is not live in ${stage}`);
  const token = await getSecret(ctx.cfg, idea.slug, stage, "ADMIN_TOKEN");
  if (!token) throw new Error(`no ADMIN_TOKEN for ${idea.slug}/${stage}`);
  const daily = await fetchMetrics(url, token, ctx.cfg.score.windowDays);
  const score = scorecard(daily, idea.activationEvent, ctx.cfg.score, rec.liveSince);
  updateApp(idea.slug, (r) => {
    r.lastScore = score;
    r.scoreHistory = [...(r.scoreHistory ?? []), score].slice(-60);
  });
  return { score, daily };
}

export async function killApp(ctx: Ctx, idea: Idea): Promise<StepReport> {
  for (const stage of [...ctx.cfg.aws.stages].reverse()) await remove(ctx.cfg, appDir(idea.slug), stage);
  updateApp(idea.slug, (r) => {
    r.status = "killed";
    r.urls = {};
  });
  return { slug: idea.slug, step: "kill", ok: true, detail: "stacks removed (tables and secrets retained)" };
}

export async function runCycle(ctx: Ctx): Promise<StepReport[]> {
  const steps: StepReport[] = [];
  const ideas = loadIdeas();
  const registry = readRegistry();
  const bySlug = new Map(ideas.map((i) => [i.slug, i]));

  // 1. Score live apps and decide.
  const scored: { idea: Idea; score: Scorecard; daily: DailyMetrics[] }[] = [];
  if (ctx.deploy) {
    for (const rec of Object.values(registry).filter((r) => r.status === "live")) {
      const idea = bySlug.get(rec.slug);
      if (!idea) continue;
      try {
        const s = await scoreApp(ctx, idea);
        scored.push({ idea, ...s });
        steps.push({ slug: idea.slug, step: "score", ok: true, detail: `${s.score.decision}: ${s.score.reason}` });
      } catch (e) {
        steps.push({ slug: idea.slug, step: "score", ok: false, detail: (e as Error).message });
      }
    }
  }

  // 2. Iterate the apps with signal (paying users first, then interest without conversion).
  const toIterate = scored
    .filter((s) => s.score.decision === "scale" || s.score.decision === "iterate")
    .sort((a, b) => b.score.paid - a.score.paid || b.score.signupRate - a.score.signupRate)
    .slice(0, ctx.cfg.run.maxIterationsPerRun);
  for (const { idea, score, daily } of toIterate) {
    const it = await iterateApp(ctx, idea, score, daily);
    steps.push(it);
    if (it.ok && ctx.deploy) steps.push(await shipApp(ctx, idea));
  }

  // 3. Kill candidates (only when autoKill is on; otherwise they are flagged in the report).
  if (ctx.cfg.autoKill && ctx.deploy)
    for (const { idea } of scored.filter((s) => s.score.decision === "kill-candidate")) steps.push(await killApp(ctx, idea));

  // 4. Build and ship new ideas.
  const fresh = ideas.filter((i) => i.status === "queued" && !registry[i.slug]).slice(0, ctx.cfg.run.maxNewIdeasPerRun);
  for (const idea of fresh) {
    const b = await buildApp(ctx, idea, { force: existsSync(appDir(idea.slug)) });
    steps.push(b);
    if (b.ok && ctx.deploy) steps.push(await shipApp(ctx, idea));
  }

  // 5. Retry shipping apps whose code is valid but were never deployed or whose deploy failed.
  if (ctx.deploy)
    for (const rec of Object.values(readRegistry()).filter(
      (r) => (r.status === "deploy-failed" || r.status === "built") && !fresh.some((f) => f.slug === r.slug),
    )) {
      const idea = bySlug.get(rec.slug);
      if (idea) steps.push(await shipApp(ctx, idea));
    }
  return steps;
}

export function scoreTable(rows: [string, Scorecard | undefined][]) {
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  return [
    "| app | decision | visitors | signups | activated | paid | signup% | activation% | paid% |",
    "|---|---|---:|---:|---:|---:|---:|---:|---:|",
    ...rows.map(([slug, s]) =>
      s
        ? `| ${slug} | ${s.decision} | ${s.visitors} | ${s.signups} | ${s.activated} | ${s.paid} | ${pct(s.signupRate)} | ${pct(s.activationRate)} | ${pct(s.paidRate)} |`
        : `| ${slug} | — | | | | | | | |`,
    ),
  ].join("\n");
}

export function renderReport(steps: StepReport[]) {
  const reg = readRegistry();
  const lines = [
    `# MVP Factory — ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC`,
    "",
    "## This run",
    "",
    ...(steps.length ? steps.map((s) => `- ${s.ok ? "✅" : "❌"} **${s.slug}** ${s.step}: ${s.detail}`) : ["- nothing to do"]),
    "",
    "## Portfolio",
    "",
    "| app | status | urls | builds | design | spend |",
    "|---|---|---|---:|---:|---:|",
    ...Object.values(reg).map((r) => {
      const design = [...r.builds].reverse().find((b) => b.designScore !== undefined)?.designScore;
      return `| ${r.slug} | ${r.status} | ${Object.entries(r.urls).map(([s, u]) => `[${s}](${u})`).join(" ")} | ${r.builds.length} | ${design === undefined ? "—" : `${design}/10`} | $${r.builds.reduce((n, b) => n + b.costUsd, 0).toFixed(2)} |`;
    }),
    "",
    "## Latest scorecards",
    "",
    scoreTable(Object.values(reg).map((r) => [r.slug, r.lastScore])),
    "",
    ...Object.values(reg)
      .filter((r) => r.lastScore)
      .map((r) => `- **${r.slug}**: ${r.lastScore!.reason}`),
  ];
  return lines.join("\n") + "\n";
}

export { loadIdea };
