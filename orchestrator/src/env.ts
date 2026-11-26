// Typed, validated environment for the orchestrator. This is the only module that reads
// process.env; everything else receives an `Env` (loaded once in cli.ts).
// Locally the values come from .env (loaded by `pnpm factory`); in GitHub Actions they come
// from repository secrets. The deployed apps do NOT use this: they read secrets from SSM.
import { z } from "zod";

/** Empty or whitespace-only strings count as "not set". */
const blank = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const optional = <T extends z.ZodType>(schema: T) => z.preprocess(blank, schema.optional());

// Messages never include the received value: these variables hold secrets.
const prefixed = (name: string, prefixes: string[]) =>
  optional(
    z.string().refine((v) => prefixes.some((p) => v.startsWith(p)), {
      message: `${name} must start with ${prefixes.map((p) => `"${p}"`).join(" or ")}`,
    }),
  );
const text = optional(z.string());

export const EnvSchema = z.object({
  // Builder agent (Claude Agent SDK): one of the two is required for build/iterate.
  ANTHROPIC_API_KEY: prefixed("ANTHROPIC_API_KEY", ["sk-ant-"]),
  CLAUDE_CODE_OAUTH_TOKEN: text,

  // AWS. Region falls back to aws.region in factory.config.yaml. Credentials are optional:
  // locally an AWS profile works, in CI they come from OIDC (configure-aws-credentials).
  AWS_REGION: optional(z.string().regex(/^[a-z]{2}(-gov)?-[a-z]+-\d+$/, "AWS_REGION must look like us-east-1")),
  AWS_ACCESS_KEY_ID: text,
  AWS_SECRET_ACCESS_KEY: text,

  // Third-party keys synced into each app's SSM secrets. FOO_<STAGE> wins over FOO.
  STRIPE_SECRET_KEY: prefixed("STRIPE_SECRET_KEY", ["sk_test_", "sk_live_"]),
  STRIPE_SECRET_KEY_DEV: prefixed("STRIPE_SECRET_KEY_DEV", ["sk_test_"]),
  STRIPE_SECRET_KEY_PROD: prefixed("STRIPE_SECRET_KEY_PROD", ["sk_test_", "sk_live_"]),
  PLUGGY_CLIENT_ID: text,
  PLUGGY_CLIENT_ID_DEV: text,
  PLUGGY_CLIENT_ID_PROD: text,
  PLUGGY_CLIENT_SECRET: text,
  PLUGGY_CLIENT_SECRET_DEV: text,
  PLUGGY_CLIENT_SECRET_PROD: text,

  // Set by GitHub Actions.
  GITHUB_SHA: optional(z.string().regex(/^[0-9a-f]{7,40}$/i, "GITHUB_SHA must be a hex commit SHA")),
  GITHUB_STEP_SUMMARY: text,

  // Overrides the repository root (defaults to the checkout containing the orchestrator).
  FACTORY_ROOT: text,
});

export type Env = z.infer<typeof EnvSchema>;
export const ENV_KEYS = Object.keys(EnvSchema.shape) as (keyof Env)[];

/** Parses and validates the environment. Throws one error listing every invalid variable. */
export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const r = EnvSchema.safeParse(source);
  if (r.success) return r.data;
  throw new Error(
    `Invalid environment variables:\n${z.prettifyError(r.error)}\n\n` +
      "Fix them in .env when running locally, or in the repository secrets in GitHub Actions.",
  );
}

export type StageSecret = "STRIPE_SECRET_KEY" | "PLUGGY_CLIENT_ID" | "PLUGGY_CLIENT_SECRET";

/** Returns FOO_<STAGE> (e.g. STRIPE_SECRET_KEY_PROD), falling back to FOO. */
export function stageSecret(env: Env, name: StageSecret, stage: string): string | undefined {
  const suffixed = (env as Record<string, string | undefined>)[`${name}_${stage.toUpperCase()}`];
  return suffixed ?? env[name];
}

export type Capability = "agent" | "aws";

const WHERE = "Set them in .env when running locally, or as repository secrets in GitHub Actions.";

/**
 * Throws if the variables a capability needs are missing, listing all of them at once.
 * `configRegion` is aws.region from factory.config.yaml, which satisfies "aws" on its own.
 */
export function requireFor(env: Env, capability: Capability | Capability[], opts: { configRegion?: string } = {}) {
  const missing: string[] = [];
  for (const cap of new Set([capability].flat())) {
    if (cap === "agent" && !env.ANTHROPIC_API_KEY && !env.CLAUDE_CODE_OAUTH_TOKEN)
      missing.push("ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN (needed by the builder agent)");
    if (cap === "aws" && !env.AWS_REGION && !opts.configRegion)
      missing.push("AWS_REGION (or aws.region in factory.config.yaml)");
  }
  if (missing.length) throw new Error(`Missing environment variables:\n${missing.map((m) => `  - ${m}`).join("\n")}\n\n${WHERE}`);
}

/**
 * Temporarily sets (string) or removes (undefined) process.env variables while `fn` runs, then
 * restores them. Used to run a generated app in-process with a sandboxed configuration.
 */
export async function withProcessEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const previous = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  const apply = (values: Record<string, string | undefined>) => {
    for (const [k, v] of Object.entries(values)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  apply(vars);
  try {
    return await fn();
  } finally {
    apply(previous);
  }
}
