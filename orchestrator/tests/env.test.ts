import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_ROOT } from "../src/config.js";
import { ENV_KEYS, loadEnv, requireFor, stageSecret } from "../src/env.js";

const valid = {
  ANTHROPIC_API_KEY: "sk-ant-api03-abc",
  AWS_REGION: "sa-east-1",
  STRIPE_SECRET_KEY: "sk_test_base",
  STRIPE_SECRET_KEY_DEV: "sk_test_dev",
  STRIPE_SECRET_KEY_PROD: "sk_live_prod",
  PLUGGY_CLIENT_ID: "pluggy-id",
  PLUGGY_CLIENT_SECRET_DEV: "pluggy-secret-dev",
  GITHUB_SHA: "ed7c966a1b2c3d4e5f60718293a4b5c6d7e8f901",
  UNRELATED: "ignored",
};

const errorOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error("expected an error");
};

describe("loadEnv", () => {
  it("parses a valid environment and drops unknown variables", () => {
    const env = loadEnv(valid);
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-api03-abc");
    expect(env.STRIPE_SECRET_KEY_PROD).toBe("sk_live_prod");
    expect(env).not.toHaveProperty("UNRELATED");
  });

  it("accepts an empty environment", () => {
    expect(loadEnv({})).toEqual({});
  });

  it("treats empty strings as undefined (and skips their validation)", () => {
    const env = loadEnv({ ANTHROPIC_API_KEY: "", STRIPE_SECRET_KEY_DEV: "  ", AWS_REGION: "" });
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.STRIPE_SECRET_KEY_DEV).toBeUndefined();
    expect(env.AWS_REGION).toBeUndefined();
  });

  it("rejects a wrong Stripe prefix, naming the variable but not its value", () => {
    const secret = "sk_live_supersecretvalue123";
    const msg = errorOf(() => loadEnv({ ...valid, STRIPE_SECRET_KEY_DEV: secret }));
    expect(msg).toContain("STRIPE_SECRET_KEY_DEV");
    expect(msg).toContain("sk_test_");
    expect(msg).not.toContain(secret);
    expect(msg).not.toContain("supersecret");
  });

  it("lists every invalid variable in one error", () => {
    const msg = errorOf(() =>
      loadEnv({ ANTHROPIC_API_KEY: "nope-key", STRIPE_SECRET_KEY: "pk_test_x", STRIPE_SECRET_KEY_PROD: "rk_live_x" }),
    );
    for (const key of ["ANTHROPIC_API_KEY", "STRIPE_SECRET_KEY", "STRIPE_SECRET_KEY_PROD"]) expect(msg).toContain(key);
    for (const value of ["nope-key", "pk_test_x", "rk_live_x"]) expect(msg).not.toContain(value);
  });
});

describe("stageSecret", () => {
  const env = loadEnv(valid);

  it("prefers the stage-specific value", () => {
    expect(stageSecret(env, "STRIPE_SECRET_KEY", "prod")).toBe("sk_live_prod");
    expect(stageSecret(env, "STRIPE_SECRET_KEY", "dev")).toBe("sk_test_dev");
    expect(stageSecret(env, "PLUGGY_CLIENT_SECRET", "dev")).toBe("pluggy-secret-dev");
  });

  it("falls back to the unsuffixed value", () => {
    expect(stageSecret(env, "PLUGGY_CLIENT_ID", "prod")).toBe("pluggy-id");
    expect(stageSecret(env, "STRIPE_SECRET_KEY", "staging")).toBe("sk_test_base");
    expect(stageSecret(env, "PLUGGY_CLIENT_SECRET", "prod")).toBeUndefined();
  });
});

describe("requireFor", () => {
  it("passes when the capability is satisfied", () => {
    expect(() => requireFor(loadEnv({ CLAUDE_CODE_OAUTH_TOKEN: "tok" }), "agent")).not.toThrow();
    expect(() => requireFor(loadEnv({ AWS_REGION: "us-east-1" }), "aws")).not.toThrow();
    expect(() => requireFor(loadEnv({}), "aws", { configRegion: "us-east-1" })).not.toThrow();
  });

  it("lists every missing variable and where to set them", () => {
    const msg = errorOf(() => requireFor(loadEnv({}), ["agent", "aws"]));
    expect(msg).toContain("ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN");
    expect(msg).toContain("AWS_REGION");
    expect(msg).toContain(".env");
    expect(msg).toContain("repository secrets");
  });
});

describe(".env.example", () => {
  const lines = readFileSync(join(DEFAULT_ROOT, ".env.example"), "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
  const entries = lines.map((l) => l.split("="));

  it("lists exactly the keys in the schema", () => {
    expect(entries.map(([k]) => k).sort()).toEqual([...ENV_KEYS].sort());
  });

  it("contains no values", () => {
    expect(entries.filter(([, v]) => v !== "").map(([k]) => k)).toEqual([]);
  });
});
