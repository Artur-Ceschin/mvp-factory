import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { z } from "zod";

export const ROOT = resolve(process.env.FACTORY_ROOT ?? join(dirname(fileURLToPath(import.meta.url)), "../.."));
export const paths = {
  root: ROOT,
  template: join(ROOT, "template"),
  apps: join(ROOT, "apps"),
  ideas: join(ROOT, "ideas"),
  registry: join(ROOT, "registry.json"),
  reports: join(ROOT, "reports"),
  prompts: join(ROOT, "orchestrator/prompts"),
  config: join(ROOT, "factory.config.yaml"),
};

const ConfigSchema = z.object({
  aws: z.object({
    region: z.string().default("us-east-1"),
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
  autoKill: z.boolean().default(false),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(file = paths.config): Config {
  return ConfigSchema.parse(parse(readFileSync(file, "utf8")));
}
