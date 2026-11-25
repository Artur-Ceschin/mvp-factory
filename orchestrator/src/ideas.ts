import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { paths } from "./config.js";

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
`;
}
