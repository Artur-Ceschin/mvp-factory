import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { z } from "zod";

import type { Env } from "./env.js";

/** The checkout that contains this orchestrator. */
export const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export function makePaths(root: string) {
  return {
    root,
    template: join(root, "template"),
    apps: join(root, "apps"),
    ideas: join(root, "ideas"),
    registry: join(root, "registry.json"),
    reports: join(root, "reports"),
    prompts: join(root, "orchestrator/prompts"),
    config: join(root, "factory.config.yaml"),
  };
}

/** Repository paths. Default to DEFAULT_ROOT; cli.ts re-roots them from env.FACTORY_ROOT. */
export const paths = makePaths(DEFAULT_ROOT);

/** Points `paths` at another root (FACTORY_ROOT). Mutates in place so existing imports see it. */
export function setRoot(root: string | undefined) {
  Object.assign(paths, makePaths(resolve(root ?? DEFAULT_ROOT)));
}

const ConfigSchema = z.object({
  aws: z.object({
    // Falls back to the AWS_REGION environment variable (see loadConfig).
    region: z.string().optional(),
    stages: z.array(z.string()).min(1).default(["dev", "prod"]),
  }),
  builder: z.object({
    model: z.string().default("claude-sonnet-4-5"),
    maxTurns: z.number().int().positive().default(80),
    maxBudgetUsdPerBuild: z.number().positive().default(8),
    maxRepairAttempts: z.number().int().min(0).default(3),
  }),
  runtime: z.object({
    bedrockModelId: z.string(),
    bedrockRegion: z.string().default("us-east-1"),
  }),
  run: z.object({
    maxNewIdeasPerRun: z.number().int().min(0).default(1),
    maxIterationsPerRun: z.number().int().min(0).default(1),
  }),
  score: z.object({
    windowDays: z.number().int().positive().default(14),
    minDaysLive: z.number().int().min(0).default(14),
    minVisitors: z.number().int().min(0).default(200),
    minSignupRate: z.number().min(0).max(1).default(0.03),
    scaleIfPaidAtLeast: z.number().int().min(1).default(3),
  }),
  design: z
    .object({
      /** Screenshot review by a vision model after the gates pass; skipped in --dry-run and without ANTHROPIC_API_KEY. */
      enabled: z.boolean().default(true),
      reviewModel: z.string().default("claude-opus-5-5"),
      minScore: z.number().min(1).max(10).default(8),
      maxPolishAttempts: z.number().int().min(0).default(2),
    })
    .prefault({}),
  autoKill: z.boolean().default(false),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(file = paths.config, env: Pick<Env, "AWS_REGION"> = {}): Config {
  const cfg = ConfigSchema.parse(parse(readFileSync(file, "utf8")));
  cfg.aws.region ??= env.AWS_REGION;
  return cfg;
}

/** The AWS region for deploys: aws.region in factory.config.yaml, else AWS_REGION. */
export function awsRegion(cfg: Config): string {
  if (!cfg.aws.region) throw new Error("No AWS region: set aws.region in factory.config.yaml or AWS_REGION");
  return cfg.aws.region;
}
