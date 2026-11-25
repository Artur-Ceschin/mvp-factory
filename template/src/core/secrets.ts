// Runtime secrets from SSM Parameter Store at /mvp/<slug>/<stage>/<NAME> (SecureString).
// Loaded once per cold start. Outside AWS (tests/dev) values come from process.env.
// CORE FILE — generated apps must not edit anything under src/core.
import { GetParametersByPathCommand, SSMClient } from "@aws-sdk/client-ssm";

export type SecretName =
  | "JWT_SECRET"
  | "ADMIN_TOKEN"
  | "STRIPE_SECRET_KEY"
  | "STRIPE_WEBHOOK_SECRET"
  | "PLUGGY_CLIENT_ID"
  | "PLUGGY_CLIENT_SECRET";

let cache: Record<string, string> | undefined;
let loadedAt = 0;
const TTL_MS = 5 * 60_000; // picks up rotated/added secrets without a redeploy

async function load(): Promise<Record<string, string>> {
  const path = process.env.SECRETS_PATH;
  if (!path || process.env.DB_DRIVER === "memory") {
    cache ??= { ...(process.env as Record<string, string>) };
    return cache;
  }
  if (cache && Date.now() - loadedAt < TTL_MS) return cache;
  const ssm = new SSMClient({});
  const out: Record<string, string> = {};
  let next: string | undefined;
  do {
    const r = await ssm.send(
      new GetParametersByPathCommand({ Path: path, WithDecryption: true, NextToken: next }),
    );
    for (const p of r.Parameters ?? []) {
      if (p.Name && p.Value) out[p.Name.slice(path.length).replace(/^\//, "")] = p.Value;
    }
    next = r.NextToken;
  } while (next);
  cache = out;
  loadedAt = Date.now();
  return out;
}

export async function secret(name: SecretName): Promise<string | undefined> {
  const v = (await load())[name];
  return v && v !== "unset" ? v : undefined;
}

export async function requireSecret(name: SecretName): Promise<string> {
  const v = await secret(name);
  if (!v) throw new Error(`Missing secret ${name}`);
  return v;
}

/** For tests. */
export function resetSecrets() {
  cache = undefined;
}
