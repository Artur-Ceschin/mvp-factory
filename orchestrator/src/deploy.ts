// Deploys an app stage with the Serverless Framework (osls) and wires secrets and Stripe webhooks.
import { CloudFormationClient, DescribeStacksCommand } from "@aws-sdk/client-cloudformation";
import { GetParameterCommand, ParameterNotFound, PutParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { randomBytes } from "node:crypto";
import { awsRegion, type Config } from "./config.js";
import { stageSecret, type Env, type StageSecret } from "./env.js";
import { log, run, tail } from "./exec.js";
import type { Idea } from "./ideas.js";

export const stackName = (slug: string, stage: string) => `mvp-${slug}-${stage}`;
export const secretsPath = (slug: string, stage: string) => `/mvp/${slug}/${stage}`;

async function getParam(ssm: SSMClient, name: string) {
  try {
    return (await ssm.send(new GetParameterCommand({ Name: name, WithDecryption: true }))).Parameter?.Value;
  } catch (e) {
    if (e instanceof ParameterNotFound || (e as Error).name === "ParameterNotFound") return undefined;
    throw e;
  }
}

async function putParam(ssm: SSMClient, name: string, value: string) {
  await ssm.send(new PutParameterCommand({ Name: name, Value: value, Type: "SecureString", Overwrite: true }));
}

export async function getSecret(cfg: Config, slug: string, stage: string, key: string) {
  return getParam(new SSMClient({ region: awsRegion(cfg) }), `${secretsPath(slug, stage)}/${key}`);
}

/** Generates per-app secrets once and syncs third-party keys from the environment. */
export async function ensureSecrets(cfg: Config, env: Env, idea: Idea, stage: string) {
  const ssm = new SSMClient({ region: awsRegion(cfg) });
  const base = secretsPath(idea.slug, stage);
  for (const key of ["JWT_SECRET", "ADMIN_TOKEN"]) {
    if (!(await getParam(ssm, `${base}/${key}`))) {
      await putParam(ssm, `${base}/${key}`, randomBytes(32).toString("base64url"));
      log(`created ${base}/${key}`);
    }
  }
  const external: StageSecret[] = [
    "STRIPE_SECRET_KEY",
    ...(idea.integrations.includes("pluggy") ? (["PLUGGY_CLIENT_ID", "PLUGGY_CLIENT_SECRET"] as const) : []),
  ];
  for (const key of external) {
    const value = stageSecret(env, key, stage);
    if (value && value !== (await getParam(ssm, `${base}/${key}`))) {
      await putParam(ssm, `${base}/${key}`, value);
      log(`synced ${base}/${key}`);
    }
  }
}

export async function stackUrl(cfg: Config, slug: string, stage: string): Promise<string> {
  const cf = new CloudFormationClient({ region: awsRegion(cfg) });
  const r = await cf.send(new DescribeStacksCommand({ StackName: stackName(slug, stage) }));
  const url = r.Stacks?.[0]?.Outputs?.find((o) => o.OutputKey === "HttpApiUrl")?.OutputValue;
  if (!url) throw new Error(`Stack ${stackName(slug, stage)} has no HttpApiUrl output`);
  return url.replace(/\/$/, "");
}

/** Creates the Stripe webhook endpoint once per app stage and stores its signing secret. */
async function ensureStripeWebhook(cfg: Config, env: Env, idea: Idea, stage: string, url: string) {
  const key = stageSecret(env, "STRIPE_SECRET_KEY", stage);
  if (!key) return;
  const ssm = new SSMClient({ region: awsRegion(cfg) });
  const name = `${secretsPath(idea.slug, stage)}/STRIPE_WEBHOOK_SECRET`;
  if (await getParam(ssm, name)) return;
  const body = new URLSearchParams({
    url: `${url}/api/billing/webhook`,
    description: `mvp-factory ${idea.slug} ${stage}`,
    "enabled_events[0]": "checkout.session.completed",
    "enabled_events[1]": "customer.subscription.deleted",
    "metadata[app]": idea.slug,
    "metadata[stage]": stage,
  });
  const r = await fetch("https://api.stripe.com/v1/webhook_endpoints", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const data = (await r.json()) as { secret?: string; error?: { message: string } };
  if (!r.ok || !data.secret) throw new Error(`Stripe webhook creation failed: ${data.error?.message ?? r.status}`);
  await putParam(ssm, name, data.secret);
  log(`created Stripe webhook for ${idea.slug}/${stage}`);
}

export async function deploy(cfg: Config, env: Env, idea: Idea, dir: string, stage: string, version: string) {
  await ensureSecrets(cfg, env, idea, stage);
  const childEnv = { APP_VERSION: version };
  const build = await run("node", ["build.mjs"], { cwd: dir, env: childEnv });
  if (build.code !== 0) throw new Error(`build failed:\n${tail(build.output)}`);
  log(`deploying ${idea.slug} → ${stage}`);
  const r = await run("npx", ["osls", "deploy", "--stage", stage, "--region", awsRegion(cfg)], {
    cwd: dir,
    env: childEnv,
    timeoutMs: 20 * 60_000,
    echo: true,
  });
  if (r.code !== 0) throw new Error(`osls deploy failed:\n${tail(r.output)}`);
  const url = await stackUrl(cfg, idea.slug, stage);
  await ensureStripeWebhook(cfg, env, idea, stage, url);
  return url;
}

/** Removes the stack. The DynamoDB table and SSM secrets are retained (DeletionPolicy: Retain). */
export async function remove(cfg: Config, dir: string, stage: string) {
  const r = await run("npx", ["osls", "remove", "--stage", stage, "--region", awsRegion(cfg)], {
    cwd: dir,
    timeoutMs: 20 * 60_000,
    echo: true,
  });
  if (r.code !== 0) throw new Error(`osls remove failed:\n${tail(r.output)}`);
}
