// Design-review gate: runs the bundled app in-process, screenshots it with Playwright (desktop and
// mobile, landing and logged in), and has a Claude vision model score it against the brand in
// SPEC.md. Below the configured minimum, the builder gets "polish" sessions with the issues.
import Anthropic from "@anthropic-ai/sdk";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { z } from "zod";
import type { Config } from "./config.js";
import { withProcessEnv } from "./env.js";
import { log } from "./exec.js";
import { brandSpec, type Idea } from "./ideas.js";

// ------------------------------------------------------------------ review result

export const CRITERIA = {
  brandFidelity: "Brand fidelity: palette, fonts, personality and voice match the visual identity exactly",
  typography: "Typography: clear hierarchy, display/body pairing used deliberately, consistent scale, comfortable measure",
  layout: "Layout and whitespace: clear grid, alignment, generous and consistent spacing, one primary action per screen",
  color: "Color use and contrast: restrained palette, accent used with intent, WCAG AA contrast everywhere",
  polish: "Polish and details: states, empty states, icons, borders, radii and shadows consistent and refined",
  copy: "Copy quality: specific, realistic, in the brand voice and the app's locale; no filler or generic phrases",
  mobile: "Mobile quality: the 390px screens are designed (not just shrunk), with comfortable tap targets",
  premium: "Does this look like a premium product people would pay for?",
} as const;

const score = z.number().min(1).max(10);

export const DesignReviewSchema = z.object({
  score,
  perCriterion: z.object(Object.fromEntries(Object.keys(CRITERIA).map((k) => [k, score])) as Record<keyof typeof CRITERIA, typeof score>),
  issues: z.array(
    z.object({
      severity: z.enum(["critical", "major", "minor"]),
      where: z.string().min(1),
      problem: z.string().min(1),
      fix: z.string().min(1),
    }),
  ),
  summary: z.string().optional(),
});

export type DesignReview = z.infer<typeof DesignReviewSchema>;

/** JSON schema sent as the structured-output format (range limits are stated in the descriptions). */
const REVIEW_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["score", "perCriterion", "issues", "summary"],
  properties: {
    score: { type: "integer", description: "Overall score from 1 (amateur) to 10 (best-in-class)." },
    perCriterion: {
      type: "object",
      additionalProperties: false,
      required: Object.keys(CRITERIA),
      properties: Object.fromEntries(
        Object.entries(CRITERIA).map(([k, d]) => [k, { type: "integer", description: `1–10. ${d}` }]),
      ),
    },
    issues: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["severity", "where", "problem", "fix"],
        properties: {
          severity: { type: "string", enum: ["critical", "major", "minor"] },
          where: { type: "string", description: "Screenshot and element, e.g. 'landing-mobile: pricing cards'." },
          problem: { type: "string" },
          fix: { type: "string", description: "A concrete change to theme.css / index.html." },
        },
      },
    },
    summary: { type: "string", description: "Two sentences: the overall impression and the single most important fix." },
  },
} as const;

/** Parses and validates a reviewer reply (tolerates code fences or text around the JSON). */
export function parseReview(text: string): DesignReview {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("design review: reply contains no JSON object");
  let data: unknown;
  try {
    data = JSON.parse(match[0]);
  } catch (e) {
    throw new Error(`design review: invalid JSON (${(e as Error).message})`);
  }
  const r = DesignReviewSchema.safeParse(data);
  if (!r.success) throw new Error(`design review: unexpected shape\n${z.prettifyError(r.error)}`);
  return r.data;
}

const SEVERITY_ORDER = { critical: 0, major: 1, minor: 2 } as const;

export function formatIssues(review: DesignReview) {
  return [...review.issues]
    .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity])
    .map((i, n) => `${n + 1}. **[${i.severity}] ${i.where}** — ${i.problem}\n   Fix: ${i.fix}`)
    .join("\n");
}

// -------------------------------------------------------------------- screenshots

export interface Screenshot {
  name: string;
  /** Absolute path of the JPEG on disk. */
  path: string;
  width: number;
  height: number;
}

export const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900, isMobile: false },
  { name: "mobile", width: 390, height: 844, isMobile: true },
] as const;

/** Long pages are cut here: the vision API rejects images over 8000px on a side. */
const MAX_SHOT_HEIGHT = 7800;
const DEMO_EMAIL = "design-review@example.com";
const DEMO_PASSWORD = "design-review-password";

export const screenshotDir = (dir: string) => join(dir, ".factory/screenshots");

interface DemoRequest {
  method: string;
  path: string;
  body?: unknown;
}

/** Requests that fill the logged-in screen: manifest.demo, else the manifest's authenticated write smoke checks. */
async function demoRequests(dir: string): Promise<DemoRequest[]> {
  const { manifest } = (await import(`${pathToFileURL(join(dir, "src/app/manifest.ts")).href}?t=${Date.now()}`)) as {
    manifest: { demo?: DemoRequest[]; smoke: (DemoRequest & { auth?: string })[] };
  };
  return manifest.demo ?? manifest.smoke.filter((s) => s.auth === "user" && s.method !== "GET");
}

/** Serves dist/handler.mjs (built by the bundle gate) on a random local port. */
async function serveBundle(dir: string): Promise<{ url: string; server: Server }> {
  const bundle = join(dir, "dist/handler.mjs");
  if (!existsSync(bundle)) throw new Error("design review: dist/handler.mjs is missing (the bundle gate must run first)");
  const { handler } = await import(`${pathToFileURL(bundle).href}?t=${Date.now()}`);
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const url = new URL(req.url ?? "/", "http://localhost");
    const out = await handler({
      rawPath: url.pathname,
      queryStringParameters: Object.fromEntries(url.searchParams),
      headers: req.headers,
      body: Buffer.concat(chunks).toString(),
      isBase64Encoded: false,
      requestContext: { http: { method: req.method } },
    });
    res.writeHead(out.statusCode, out.headers);
    res.end(out.body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server };
}

/**
 * Runs the app in-process with an in-memory DB and stubbed AI, signs up a demo user, sends the
 * manifest's demo requests, and captures landing + logged-in screens at desktop and mobile sizes.
 */
export async function captureScreenshots(dir: string, idea: Idea, cfg: Config): Promise<Screenshot[]> {
  const out = screenshotDir(dir);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const appEnv: Record<string, string | undefined> = {
    DB_DRIVER: "memory",
    AI_DRIVER: "stub",
    JWT_SECRET: "design-review",
    ADMIN_TOKEN: "design-review",
    STAGE: "design",
    APP_SLUG: idea.slug,
    APP_NAME: idea.name,
    APP_LOCALE: idea.locale,
    PRICE_CENTS: String(idea.pricing.monthlyCents),
    PRICE_CURRENCY: idea.pricing.currency.toLowerCase(),
    BEDROCK_MODEL_ID: cfg.runtime.bedrockModelId,
    SECRETS_PATH: undefined,
    // The app runs inside the orchestrator: keep the orchestrator's credentials out of its reach.
    ANTHROPIC_API_KEY: undefined,
    CLAUDE_CODE_OAUTH_TOKEN: undefined,
    AWS_ACCESS_KEY_ID: undefined,
    AWS_SECRET_ACCESS_KEY: undefined,
    AWS_SESSION_TOKEN: undefined,
    STRIPE_SECRET_KEY: undefined,
    PLUGGY_CLIENT_ID: undefined,
    PLUGGY_CLIENT_SECRET: undefined,
  };
  return withProcessEnv(appEnv, async () => {
    const { url, server } = await serveBundle(dir);
    const browser = await chromium.launch({ headless: true }).catch((e: Error) => {
      server.close();
      throw new Error(`design review: cannot start Chromium (run \`pnpm exec playwright install chromium\`): ${e.message}`);
    });
    try {
      const signup = await fetch(`${url}/api/auth/signup`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: DEMO_EMAIL, password: DEMO_PASSWORD }),
      });
      const { token } = (await signup.json()) as { token?: string };
      if (!token) throw new Error(`design review: demo signup failed (${signup.status})`);
      for (const r of await demoRequests(dir)) {
        const res = await fetch(url + r.path, {
          method: r.method,
          headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
          body: JSON.stringify(r.body ?? {}),
        });
        if (!res.ok) log(`design review: demo request ${r.method} ${r.path} returned ${res.status}`);
      }

      const shots: Screenshot[] = [];
      for (const vp of VIEWPORTS) {
        const context = await browser.newContext({
          viewport: { width: vp.width, height: vp.height },
          deviceScaleFactor: 1,
          isMobile: vp.isMobile,
          hasTouch: vp.isMobile,
          locale: idea.locale,
        });
        const page = await context.newPage();
        const shoot = async (screen: string) => {
          await page.waitForLoadState("networkidle").catch(() => {});
          await page.evaluate(() => document.fonts.ready.then(() => undefined));
          await page.waitForTimeout(400); // let entrance animations settle
          const fullHeight = await page.evaluate(() => document.documentElement.scrollHeight);
          const height = Math.min(fullHeight, MAX_SHOT_HEIGHT);
          const path = join(out, `${screen}-${vp.name}.jpg`);
          await page.screenshot({ path, type: "jpeg", quality: 82, fullPage: true, clip: { x: 0, y: 0, width: vp.width, height } });
          shots.push({ name: `${screen}-${vp.name}`, path, width: vp.width, height });
        };
        await page.goto(url, { waitUntil: "load" });
        await shoot("landing");
        await page.evaluate((t) => localStorage.setItem("mvp_token", t), token);
        await page.reload({ waitUntil: "load" });
        await shoot("app");
        await context.close();
      }
      return shots;
    } finally {
      await browser.close();
      await new Promise((resolve) => server.close(resolve));
    }
  });
}

// ------------------------------------------------------------------------ reviewer

export interface DesignReviewResult {
  review: DesignReview;
  screenshots: Screenshot[];
}

export interface DesignReviewer {
  review(dir: string, idea: Idea): Promise<DesignReviewResult>;
}

const RUBRIC = `You are a principal product designer reviewing a web app before launch. You hold it to the
bar of the best product sites and apps (Linear, Stripe, Arc): opinionated, coherent and
premium. Be strict: a 10 is best-in-class and rare, 8 is a polished product people would pay
for, 6 is a decent template, 4 or less is amateur. Generic "AI-generated" looks (default system
fonts, centered-everything layouts, purple-blue gradients, glassmorphism everywhere, emoji
icons, stock-photo placeholders, lorem ipsum, "Welcome to our app") cap the score at 5.

Score each criterion from 1 to 10:
${Object.entries(CRITERIA)
  .map(([k, d]) => `- ${k}: ${d}`)
  .join("\n")}

The overall score is your holistic judgment, not an average. List every issue worth fixing,
most severe first, each with where it is (screenshot name + element), the problem, and a
concrete fix in CSS/HTML terms. Judge only what is visible in the screenshots.`;

export class ClaudeDesignReviewer implements DesignReviewer {
  private client: Anthropic;

  constructor(
    private cfg: Config,
    apiKey: string,
  ) {
    this.client = new Anthropic({ apiKey });
  }

  async review(dir: string, idea: Idea): Promise<DesignReviewResult> {
    const screenshots = await captureScreenshots(dir, idea, this.cfg);
    const content: Anthropic.Beta.BetaContentBlockParam[] = [];
    for (const s of screenshots) {
      content.push({ type: "text", text: `Screenshot "${s.name}" (${s.width}px wide):` });
      content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: readFileSync(s.path).toString("base64") } });
    }
    content.push({
      type: "text",
      text: `The app is "${idea.name}" (${idea.pitch}). Locale: ${idea.locale}.\n\nIts visual identity, from SPEC.md:\n\n${brandSpec(idea.brand)}\nReview the screenshots above against this identity and the rubric.`,
    });
    const msg = await this.client.beta.messages.create({
      model: this.cfg.design.reviewModel,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "high", format: { type: "json_schema", schema: REVIEW_JSON_SCHEMA } },
      system: RUBRIC,
      messages: [{ role: "user", content }],
    });
    if (msg.stop_reason === "refusal") throw new Error("design review: the model declined to review the screenshots");
    if (msg.stop_reason === "max_tokens") throw new Error("design review: the reply was cut off (max_tokens)");
    const text = msg.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
    const review = parseReview(text);
    writeFileSync(join(screenshotDir(dir), "review.json"), JSON.stringify(review, null, 2) + "\n");
    return { review, screenshots };
  }
}

// --------------------------------------------------------------------- polish loop

export interface DesignLoopResult {
  ok: boolean;
  /** Every score, in order: the initial review, then one per polish attempt. */
  scores: number[];
  last?: DesignReviewResult;
  reason: string;
}

/** Variables for prompts/polish.md. */
export function polishVars(dir: string, r: DesignReviewResult, minScore: number): Record<string, string> {
  return {
    SCORE: String(r.review.score),
    MIN_SCORE: String(minScore),
    SUMMARY: r.review.summary ?? "",
    ISSUES: formatIssues(r.review) || "(no specific issues listed; raise the overall quality)",
    SCREENSHOTS: r.screenshots.map((s) => `- \`${relative(dir, s.path)}\` (${s.name}, ${s.width}px wide)`).join("\n"),
  };
}

/**
 * Review → (polish → gates → review)* until the score reaches minScore or the polish attempts run
 * out. `polish` runs the builder; `revalidate` re-runs every gate (with repairs) and reports success.
 */
export async function designLoop(opts: {
  design: Config["design"];
  review: () => Promise<DesignReviewResult>;
  polish: (last: DesignReviewResult, attempt: number) => Promise<void>;
  revalidate: () => Promise<boolean>;
}): Promise<DesignLoopResult> {
  const { minScore, maxPolishAttempts } = opts.design;
  const scores: number[] = [];
  let last: DesignReviewResult;
  try {
    last = await opts.review();
  } catch (e) {
    return { ok: false, scores, reason: (e as Error).message };
  }
  scores.push(last.review.score);
  log(`design review: ${last.review.score}/10 (min ${minScore})`);
  for (let attempt = 1; last.review.score < minScore; attempt++) {
    if (attempt > maxPolishAttempts)
      return { ok: false, scores, last, reason: `design score ${last.review.score}/10 is below ${minScore} after ${maxPolishAttempts} polish attempt(s)` };
    log(`design polish attempt ${attempt}`);
    await opts.polish(last, attempt);
    if (!(await opts.revalidate())) return { ok: false, scores, last, reason: `gates failed after design polish attempt ${attempt}` };
    try {
      last = await opts.review();
    } catch (e) {
      return { ok: false, scores, last, reason: (e as Error).message };
    }
    scores.push(last.review.score);
    log(`design review: ${last.review.score}/10 (min ${minScore})`);
  }
  return { ok: true, scores, last, reason: `design ${last.review.score}/10` };
}
