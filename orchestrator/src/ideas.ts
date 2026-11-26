import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { paths } from "./config.js";

const HEX = /^#[0-9a-f]{6}$/i;
const hex = z.string().regex(HEX, "must be a 6-digit hex color like #1a2b3c");

/** WCAG 2.x relative luminance of a #rrggbb color. */
export function luminance(color: string) {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(color.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

/** WCAG contrast ratio between two #rrggbb colors (1–21). */
export function contrastRatio(a: string, b: string) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

/** WCAG AA for normal-size text. */
export const MIN_CONTRAST = 4.5;

/** Pairs that carry text and must meet MIN_CONTRAST: [foreground, background]. */
export const CONTRAST_PAIRS = [
  ["text", "background"],
  ["text", "surface"],
  ["muted", "background"],
  ["primaryInk", "primary"],
] as const;

const fontFamily = z.string().regex(/^[A-Za-z0-9 ]{2,40}$/, "a Google Fonts family name, e.g. \"DM Sans\"");

export const BrandSchema = z
  .object({
    personality: z.array(z.string().min(2)).min(3).max(5),
    /** Tone of the copy. */
    voice: z.string().min(10),
    palette: z.object({
      background: hex,
      surface: hex,
      text: hex,
      muted: hex,
      primary: hex,
      primaryInk: hex,
      accent: hex,
    }),
    /** Google Fonts family names, served through Bunny Fonts. */
    typography: z.object({ display: fontFamily, body: fontFamily, mono: fontFamily.optional() }),
    /** Products whose design quality to aim for. Inspiration only: never copy their branding. */
    references: z.array(z.string().min(2)).min(1),
    /** Design clichés to stay away from. */
    avoid: z.array(z.string().min(2)).min(1),
  })
  .superRefine((brand, ctx) => {
    const p = brand.palette;
    if (Object.values(p).some((c) => !HEX.test(c))) return; // reported by the field validators
    for (const [fg, bg] of CONTRAST_PAIRS) {
      const ratio = contrastRatio(p[fg], p[bg]);
      if (ratio < MIN_CONTRAST)
        ctx.addIssue({
          code: "custom",
          path: ["palette", fg],
          message: `contrast ${fg} ${p[fg]} on ${bg} ${p[bg]} is ${ratio.toFixed(2)}:1; WCAG AA needs ${MIN_CONTRAST}:1`,
        });
    }
  });

export type Brand = z.infer<typeof BrandSchema>;

/** Bunny Fonts (privacy-friendly Google Fonts mirror) stylesheet URL for a brand's typography. */
export function fontsUrl(t: Brand["typography"]) {
  const fam = (name: string, weights: string) => `${name.toLowerCase().replaceAll(" ", "-")}:${weights}`;
  const families = [fam(t.display, "500,600,700,800"), fam(t.body, "400,500,600,700")];
  if (t.mono) families.push(fam(t.mono, "400,500"));
  return `https://fonts.bunny.net/css?family=${[...new Set(families)].join("|")}&display=swap`;
}

export const IdeaSchema = z.object({
  slug: z.string().regex(/^[a-z][a-z0-9-]{2,30}$/, "slug: lowercase, 3-31 chars, letters/digits/hyphens"),
  name: z.string().min(2),
  priority: z.number().int().default(100),
  status: z.enum(["queued", "paused"]).default("queued"),
  /** Language/market of everything the end user sees. Code and docs are always English. */
  locale: z.enum(["en-US", "pt-BR"]).default("en-US"),
  pitch: z.string().min(10),
  audience: z.string().min(5),
  problem: z.string().min(10),
  pricing: z.object({
    currency: z.string().length(3).default("usd"),
    monthlyCents: z.number().int().positive(),
    freeTier: z.string().min(5),
    proTier: z.string().min(5),
  }),
  activationEvent: z.string().regex(/^[a-z][a-z0-9_]{1,39}$/),
  features: z.array(z.string()).min(2),
  integrations: z.array(z.enum(["bedrock", "pluggy", "stripe"])).default(["stripe"]),
  constraints: z.array(z.string()).default([]),
  outOfScope: z.array(z.string()).default([]),
  /** Visual identity every screen must follow. */
  brand: BrandSchema,
});

export type Idea = z.infer<typeof IdeaSchema>;

export function loadIdeas(dir = paths.ideas): Idea[] {
  const ideas = readdirSync(dir)
    .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
    .map((f) => {
      try {
        return IdeaSchema.parse(parse(readFileSync(join(dir, f), "utf8")));
      } catch (e) {
        throw new Error(`Invalid idea file ${f}: ${(e as Error).message}`);
      }
    });
  const slugs = new Set<string>();
  for (const i of ideas) {
    if (slugs.has(i.slug)) throw new Error(`Duplicate idea slug ${i.slug}`);
    slugs.add(i.slug);
  }
  return ideas.sort((a, b) => a.priority - b.priority);
}

export function loadIdea(slug: string): Idea {
  const idea = loadIdeas().find((i) => i.slug === slug);
  if (!idea) throw new Error(`No idea with slug '${slug}' in ideas/`);
  return idea;
}

const LOCALE_NOTE: Record<Idea["locale"], string> = {
  "en-US": "all user-facing text (UI, emails, error messages, AI output) in US English.",
  "pt-BR": "all user-facing text (UI, error messages, AI output) in Brazilian Portuguese. Code, comments and tests stay in English.",
};

export function formatPrice(idea: Idea) {
  return new Intl.NumberFormat(idea.locale, { style: "currency", currency: idea.pricing.currency.toUpperCase() }).format(
    idea.pricing.monthlyCents / 100,
  );
}

/** Markdown spec handed to the builder agent. */
export function ideaToSpec(idea: Idea): string {
  const price = formatPrice(idea);
  const list = (xs: string[]) => (xs.length ? xs.map((x) => `- ${x}`).join("\n") : "- (none)");
  return `# ${idea.name}

**Pitch:** ${idea.pitch}

**Audience:** ${idea.audience}

**Problem:** ${idea.problem}

**Locale:** \`${idea.locale}\` — ${LOCALE_NOTE[idea.locale]}

## Pricing
- Pro: ${price}/month (Stripe Checkout is already implemented by the core)
- Free tier: ${idea.pricing.freeTier}
- Pro tier: ${idea.pricing.proTier}

## Activation event
\`${idea.activationEvent}\` — track it with \`track("${idea.activationEvent}", user.id)\` at the moment a user gets real value.

## Features (MVP scope)
${list(idea.features)}

## Integrations
${list(idea.integrations)}

## Constraints
${list(idea.constraints)}

## Out of scope
${list(idea.outOfScope)}

${brandSpec(idea.brand)}`;
}

export const PALETTE_TOKENS: Record<keyof Brand["palette"], string> = {
  background: "--color-bg",
  surface: "--color-surface",
  text: "--color-text",
  muted: "--color-muted",
  primary: "--color-primary",
  primaryInk: "--color-primary-ink",
  accent: "--color-accent",
};

/** The "Visual identity" section of SPEC.md (also sent to the design reviewer). */
export function brandSpec(brand: Brand): string {
  const t = brand.typography;
  const list = (xs: string[]) => xs.map((x) => `- ${x}`).join("\n");
  return `## Visual identity

**Personality:** ${brand.personality.join(", ")}

**Voice:** ${brand.voice}

### Palette
Set these in \`src/app/web/theme.css\` (\`:root\`). Contrast pairs are checked for WCAG AA.

| Role | Token | Value |
|---|---|---|
${(Object.keys(PALETTE_TOKENS) as (keyof Brand["palette"])[]).map((k) => `| ${k} | \`${PALETTE_TOKENS[k]}\` | \`${brand.palette[k]}\` |`).join("\n")}

### Typography
- Display (headlines, numbers that matter): **${t.display}** → \`--font-display\`
- Body (UI and copy): **${t.body}** → \`--font-body\`
${t.mono ? `- Mono (code, data): **${t.mono}** → \`--font-mono\`\n` : ""}- Load them in \`index.html\` with exactly:
  \`<link rel="stylesheet" href="${fontsUrl(t)}" />\`

### Design references (quality bar only — never copy their branding)
${list(brand.references)}

### Avoid
${list(brand.avoid)}
`;
}
