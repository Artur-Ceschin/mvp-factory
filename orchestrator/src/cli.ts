#!/usr/bin/env -S npx tsx
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { ClaudeBuilder, MockBuilder } from "./builder.js";
import { loadConfig, paths } from "./config.js";
import { deploy as deployStage, stackUrl } from "./deploy.js";
import { failureReport, passed, validate } from "./gates.js";
import { loadIdea, loadIdeas } from "./ideas.js";
import {
  buildApp,
  iterateApp,
  killApp,
  renderReport,
  runCycle,
  scoreApp,
  shipApp,
  type Ctx,
  type StepReport,
} from "./pipeline.js";
import { readRegistry, updateApp, writeRegistry } from "./registry.js";
import { appDir, coreDrift, syncCore } from "./scaffold.js";
import { verify } from "./verify.js";

const HELP = `mvp-factory

  factory list                         ideas and app status
  factory run [--dry-run]              full cycle: score → iterate → build new ideas → ship
  factory build <slug> [--force]       generate the app with the builder agent + validation loop
  factory validate <slug>              run the validation gates
  factory ship <slug>                  deploy all stages (dev → prod) with smoke tests
  factory deploy <slug> --stage s      deploy a single stage
  factory verify <slug> --stage s      smoke-test a deployed stage
  factory score [slug]                 fetch metrics and update scorecards
  factory iterate <slug>               improve a live app from its metrics (then ship)
  factory sync-core [slug]             copy template core files into apps
  factory reset <slug>                 forget a failed build so the next run rebuilds it
  factory kill <slug> --confirm        remove an app's stacks (data is retained)

  --dry-run   use the mock builder and skip AWS (no API keys needed)
`;

const { values: flags, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    "dry-run": { type: "boolean", default: false },
    force: { type: "boolean", default: false },
    confirm: { type: "boolean", default: false },
    stage: { type: "string" },
    help: { type: "boolean", short: "h", default: false },
  },
});

const [cmd, slug] = positionals;
const cfg = loadConfig();
const dry = flags["dry-run"]!;
const ctx: Ctx = {
  cfg,
  builder: dry ? new MockBuilder() : new ClaudeBuilder(cfg),
  deploy: !dry,
  version: process.env.GITHUB_SHA?.slice(0, 7) ?? `local-${Date.now()}`,
};

function need<T>(v: T | undefined, what: string): T {
  if (!v) {
    console.error(`missing ${what}\n\n${HELP}`);
    process.exit(2);
  }
  return v;
}

function publish(steps: StepReport[]) {
  const md = renderReport(steps);
  mkdirSync(paths.reports, { recursive: true });
  writeFileSync(join(paths.reports, "latest.md"), md);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
  console.log(`\n${md}`);
  return steps.every((s) => s.ok);
}

async function main() {
  if (flags.help || !cmd) return console.log(HELP), true;
  switch (cmd) {
    case "list": {
      const reg = readRegistry();
      for (const i of loadIdeas())
        console.log(`${String(i.priority).padStart(4)}  ${i.slug.padEnd(24)} ${i.status.padEnd(7)} ${reg[i.slug]?.status ?? "-"}`);
      return true;
    }
    case "run":
      return publish(await runCycle(ctx));
    case "build": {
      const idea = loadIdea(need(slug, "<slug>"));
      return publish([await buildApp(ctx, idea, { force: flags.force || readRegistry()[idea.slug]?.status === "build-failed" })]);
    }
    case "validate": {
      const gates = await validate(appDir(need(slug, "<slug>")), { region: cfg.aws.region });
      for (const g of gates) console.log(`${g.ok ? "✅" : "❌"} ${g.gate} (${g.ms}ms)`);
      if (!passed(gates)) console.log(`\n${failureReport(gates)}`);
      return passed(gates);
    }
    case "ship":
      return publish([await shipApp(ctx, loadIdea(need(slug, "<slug>")))]);
    case "deploy": {
      const idea = loadIdea(need(slug, "<slug>"));
      const stage = need(flags.stage, "--stage");
      const url = await deployStage(cfg, idea, appDir(idea.slug), stage, ctx.version);
      updateApp(idea.slug, (r) => (r.urls[stage] = url));
      console.log(url);
      return true;
    }
    case "verify": {
      const s = need(slug, "<slug>");
      const results = await verify(await stackUrl(cfg, s, need(flags.stage, "--stage")), appDir(s));
      return results.every((r) => r.ok);
    }
    case "score": {
      const live = Object.values(readRegistry()).filter((r) => r.status === "live" && (!slug || r.slug === slug));
      const steps: StepReport[] = [];
      for (const r of live) {
        try {
          const { score } = await scoreApp(ctx, loadIdea(r.slug));
          steps.push({ slug: r.slug, step: "score", ok: true, detail: `${score.decision}: ${score.reason}` });
        } catch (e) {
          steps.push({ slug: r.slug, step: "score", ok: false, detail: (e as Error).message });
        }
      }
      return publish(steps);
    }
    case "iterate": {
      const idea = loadIdea(need(slug, "<slug>"));
      const { score, daily } = dry
        ? { score: readRegistry()[idea.slug]?.lastScore, daily: [] }
        : await scoreApp(ctx, idea);
      if (!score) throw new Error(`${idea.slug} has no scorecard yet`);
      const it = await iterateApp(ctx, idea, score, daily);
      return publish(it.ok && ctx.deploy ? [it, await shipApp(ctx, idea)] : [it]);
    }
    case "sync-core": {
      const slugs = slug ? [slug] : Object.keys(readRegistry()).filter((s) => existsSync(appDir(s)));
      for (const s of slugs) {
        syncCore(appDir(s));
        console.log(`${s}: ${coreDrift(appDir(s)).length === 0 ? "in sync" : "DRIFT REMAINS"}`);
      }
      return true;
    }
    case "reset": {
      const reg = readRegistry();
      const s = need(slug, "<slug>");
      if (reg[s]?.status === "live") throw new Error(`${s} is live; use iterate or kill`);
      delete reg[s];
      writeRegistry(reg);
      console.log(`${s} will be rebuilt on the next run`);
      return true;
    }
    case "kill": {
      if (!flags.confirm) throw new Error("kill removes the app's stacks from AWS; re-run with --confirm");
      return publish([await killApp(ctx, loadIdea(need(slug, "<slug>")))]);
    }
    default:
      console.log(HELP);
      return false;
  }
}

main().then(
  (ok) => process.exit(ok ? 0 : 1),
  (e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  },
);
