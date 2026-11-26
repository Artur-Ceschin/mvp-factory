import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Builder, BuildTask } from "../src/builder.js";
import { DEFAULT_ROOT, loadConfig, paths, setRoot } from "../src/config.js";
import { designLoop, formatIssues, parseReview, polishVars, type DesignReview, type DesignReviewer, type DesignReviewResult } from "../src/design.js";
import { designPolicy, type GateResult } from "../src/gates.js";
import { BrandSchema, contrastRatio, ideaToSpec, IdeaSchema, loadIdea, loadIdeas } from "../src/ideas.js";
import { buildApp } from "../src/pipeline.js";
import { readRegistry } from "../src/registry.js";

const cfg = loadConfig();

const review = (score: number, issues: DesignReview["issues"] = []): DesignReview => ({
  score,
  perCriterion: { brandFidelity: score, typography: score, layout: score, color: score, polish: score, copy: score, mobile: score, premium: score },
  issues,
  summary: `scored ${score}`,
});
const result = (score: number): DesignReviewResult => ({
  review: review(score, [{ severity: "major", where: "landing-desktop: hero", problem: "weak hierarchy", fix: "use --step-5" }]),
  screenshots: [{ name: "landing-desktop", path: "/app/.factory/screenshots/landing-desktop.jpg", width: 1440, height: 3000 }],
});

describe("brand schema", () => {
  const valid = loadIdeas()[0]!.brand;

  it("every idea has a valid brand rendered into SPEC.md", () => {
    for (const idea of loadIdeas()) {
      const spec = ideaToSpec(idea);
      expect(spec).toContain("## Visual identity");
      expect(spec).toContain(idea.brand.typography.display);
      expect(spec).toContain(idea.brand.palette.primary);
      expect(spec).toContain("https://fonts.bunny.net/css?family=");
    }
  });

  it("computes WCAG contrast", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 1);
    expect(contrastRatio("#ffffff", "#ffffff")).toBeCloseTo(1, 5);
  });

  it("rejects malformed colors and missing fields", () => {
    expect(BrandSchema.safeParse({ ...valid, palette: { ...valid.palette, primary: "lime" } }).success).toBe(false);
    expect(BrandSchema.safeParse({ ...valid, personality: ["bold"] }).success).toBe(false);
    const { brand: _, ...noBrand } = loadIdea("study-cards");
    expect(IdeaSchema.safeParse(noBrand).success).toBe(false);
  });

  it("rejects a palette that fails WCAG AA, naming the pair", () => {
    const r = BrandSchema.safeParse({ ...valid, palette: { ...valid.palette, primary: "#c6f432", primaryInk: "#ffffff" } });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error!.issues)).toMatch(/primaryInk .* on primary .*WCAG AA/);
    const lowText = BrandSchema.safeParse({ ...valid, palette: { ...valid.palette, background: "#777777", text: "#888888" } });
    expect(lowText.success).toBe(false);
  });
});

describe("design code policy", () => {
  let dir: string;
  const write = (rel: string, content: string) => {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), content);
  };
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "design-policy-"));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const reset = () => {
    rmSync(join(dir, "src"), { recursive: true, force: true });
    cpSync(join(DEFAULT_ROOT, "template/src/app/web"), join(dir, "src/app/web"), { recursive: true });
  };

  it("the template's placeholder app passes", () => {
    reset();
    expect(designPolicy(dir)).toEqual([]);
  });

  it("fails on external hosts other than fonts.bunny.net (svg namespaces are fine)", () => {
    reset();
    write("src/app/web/theme.css", `${"@import url('https://cdn.example.com/x.css');"}\n:root{--color-bg:#fff;--color-surface:#fff;--color-text:#000;--color-muted:#333;--color-primary:#000;--color-primary-ink:#fff;--color-accent:#f00;--font-display:x;--font-body:y}`);
    const hits = designPolicy(dir);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatch(/theme\.css: references external host cdn\.example\.com/);
  });

  it("fails when index.html misses the theme or font links", () => {
    reset();
    write("src/app/web/index.html", '<html><head><link rel="stylesheet" href="/_base.css" /></head><body></body></html>');
    const hits = designPolicy(dir).join("\n");
    expect(hits).toContain('href="/_theme.css"');
    expect(hits).toContain("fonts.bunny.net stylesheet");
    expect(hits).not.toContain("/_base.css");
  });

  it("fails when theme.css lacks core tokens", () => {
    reset();
    write("src/app/web/theme.css", ":root { --color-bg: #fff; /* --font-display: x; */ }");
    const hits = designPolicy(dir).join("\n");
    expect(hits).toContain("--color-primary");
    expect(hits).toContain("--font-display");
    expect(hits).not.toContain("--color-bg,");
  });

  it("fails on emoji used as icons, but allows plain symbols", () => {
    reset();
    const html = `<!doctype html><html><head>
<link rel="stylesheet" href="https://fonts.bunny.net/css?family=dm-sans:400" />
<link rel="stylesheet" href="/_base.css" /><link rel="stylesheet" href="/_theme.css" />
</head><body>
<p>&copy; 2026 · ✓ done → next</p>
<button>🚀 Start</button>
</body></html>`;
    write("src/app/web/index.html", html);
    const hits = designPolicy(dir);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatch(/index\.html:6: emoji "🚀"/);
  });
});

describe("design review parser", () => {
  it("accepts valid JSON, with or without code fences", () => {
    const json = JSON.stringify(review(7, [{ severity: "minor", where: "app-mobile", problem: "tight", fix: "more padding" }]));
    expect(parseReview(json).score).toBe(7);
    expect(parseReview("```json\n" + json + "\n```").issues).toHaveLength(1);
  });

  it("rejects invalid JSON and the wrong shape", () => {
    expect(() => parseReview("no json here")).toThrow(/no JSON/);
    expect(() => parseReview("{ score: 7, }")).toThrow(/invalid JSON/);
    expect(() => parseReview(JSON.stringify({ ...review(7), score: 14 }))).toThrow(/unexpected shape/);
    const { perCriterion: _, ...noCriteria } = review(7);
    expect(() => parseReview(JSON.stringify(noCriteria))).toThrow(/perCriterion/);
  });

  it("formats issues by severity and builds polish prompt variables", () => {
    const r = review(5, [
      { severity: "minor", where: "a", problem: "p1", fix: "f1" },
      { severity: "critical", where: "b", problem: "p2", fix: "f2" },
    ]);
    expect(formatIssues(r).indexOf("[critical]")).toBeLessThan(formatIssues(r).indexOf("[minor]"));
    const vars = polishVars("/app", result(5), 8);
    expect(vars.SCREENSHOTS).toContain("`.factory/screenshots/landing-desktop.jpg`");
    expect(vars.MIN_SCORE).toBe("8");
  });
});

describe("design polish loop", () => {
  const design = { enabled: true, reviewModel: "x", minScore: 8, maxPolishAttempts: 2 };

  it("passes once the score reaches minScore", async () => {
    const scores = [6, 7, 9];
    let polished = 0;
    const r = await designLoop({
      design,
      review: async () => result(scores.shift()!),
      polish: async () => void polished++,
      revalidate: async () => true,
    });
    expect(r.ok).toBe(true);
    expect(r.scores).toEqual([6, 7, 9]);
    expect(polished).toBe(2);
  });

  it("stops after maxPolishAttempts when the score never improves", async () => {
    let polished = 0;
    const r = await designLoop({ design, review: async () => result(5), polish: async () => void polished++, revalidate: async () => true });
    expect(r.ok).toBe(false);
    expect(r.scores).toEqual([5, 5, 5]);
    expect(polished).toBe(2);
    expect(r.reason).toMatch(/below 8 after 2 polish/);
  });

  it("fails when a polish breaks the gates or the reviewer errors", async () => {
    const broken = await designLoop({ design, review: async () => result(5), polish: async () => {}, revalidate: async () => false });
    expect(broken).toMatchObject({ ok: false, scores: [5] });
    expect(broken.reason).toMatch(/gates failed/);
    const error = await designLoop({ design, review: async () => Promise.reject(new Error("no chromium")), polish: async () => {}, revalidate: async () => true });
    expect(error).toMatchObject({ ok: false, scores: [], reason: "no chromium" });
  });
});

describe("design review in the build pipeline", () => {
  // Loaded before the paths are re-rooted to the temporary factory.
  const ideas = Object.fromEntries(loadIdeas().map((i) => [i.slug, i]));
  let root: string;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "factory-root-"));
    cpSync(join(DEFAULT_ROOT, "template"), join(root, "template"), {
      recursive: true,
      filter: (src) => !/[\\/](node_modules|dist|\.factory)$/.test(src),
    });
    mkdirSync(join(root, "apps"));
    setRoot(root);
  });
  afterAll(() => {
    setRoot(undefined);
    rmSync(root, { recursive: true, force: true });
  });

  const okGates = async (): Promise<GateResult[]> => [{ gate: "tests", ok: true, output: "", ms: 1 }];
  const fakeBuilder = () => {
    const modes: BuildTask["mode"][] = [];
    const builder: Builder = { run: async (t) => (modes.push(t.mode), { ok: true, costUsd: 0.5, summary: `${t.mode} done` }) };
    return { builder, modes };
  };
  const fakeReviewer = (scores: number[]): DesignReviewer => ({ review: async () => result(scores.shift() ?? 5) });

  it("records each design score and passes when polish lifts the score", async () => {
    const { builder, modes } = fakeBuilder();
    const idea = { ...ideas["study-cards"]!, slug: "design-pass" };
    const step = await buildApp({ cfg, env: {}, builder, deploy: false, version: "t", validate: okGates, reviewer: fakeReviewer([6, 9]) }, idea);
    expect(step.ok).toBe(true);
    expect(step.detail).toContain("design 9/10");
    expect(modes).toEqual(["build", "polish"]);
    const rec = readRegistry()[idea.slug]!;
    expect(rec.status).toBe("built");
    expect(rec.builds[0]).toMatchObject({ designScore: 9, designScores: [6, 9], attempts: 2, costUsd: 1 });
    expect(paths.root).toBe(root);
  });

  it("marks the build failed when the score never reaches minScore", async () => {
    const { builder, modes } = fakeBuilder();
    const idea = { ...ideas["calisthenics-coach"]!, slug: "design-fail" };
    const step = await buildApp({ cfg, env: {}, builder, deploy: false, version: "t", validate: okGates, reviewer: fakeReviewer([4, 5, 5]) }, idea);
    expect(step.ok).toBe(false);
    expect(step.detail).toMatch(/design score 5\/10 is below 8/);
    expect(modes).toEqual(["build", "polish", "polish"]);
    const rec = readRegistry()[idea.slug]!;
    expect(rec.status).toBe("build-failed");
    expect(rec.builds[0]).toMatchObject({ ok: false, designScore: 5, designScores: [4, 5, 5] });
  });

  it("skips the review when no reviewer is configured (dry run)", async () => {
    const { builder, modes } = fakeBuilder();
    const idea = { ...ideas["br-expense-tracker"]!, slug: "design-skip" };
    const step = await buildApp({ cfg, env: {}, builder, deploy: false, version: "t", validate: okGates }, idea);
    expect(step.ok).toBe(true);
    expect(modes).toEqual(["build"]);
    expect(readRegistry()[idea.slug]!.builds[0]!.designScore).toBeUndefined();
  });
});
