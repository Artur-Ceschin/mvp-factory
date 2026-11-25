# MVP Factory

An autonomous factory for paid MVPs. It takes ideas from `ideas/*.yaml`, has a Claude agent build
each one as a working app, validates it, deploys it to AWS (Lambda + DynamoDB via the Serverless
Framework), measures real usage in production and decides what to do next: **iterate**, **scale**
or **kill**.

```
ideas/*.yaml ──► build (Claude agent) ──► gates ──✗──► repair (agent) ─┐
                                            │ ✓                        │ up to N times
                                            ▼                          │
                      deploy dev ──► smoke ──► deploy prod ──► smoke ◄─┘
                                                                 │
                    daily score (/api/_metrics) ◄────────────────┘
                      │
      scale / iterate ──► agent improves the funnel ──► gates ──► deploy
      needs-traffic   ──► report only (no traffic, no validation)
      kill-candidate  ──► opens an issue (or removes it if autoKill: true)
```

## How it works

| Part | What it does |
|---|---|
| `template/` | Base app every MVP inherits: email/password auth (JWT), Stripe Checkout + webhooks, analytics, AI via Bedrock, Brazilian Open Finance via Pluggy, account deletion (GDPR/LGPD), and a single-page app served by the Lambda itself. |
| `template/src/core` | **Protected.** The agent cannot change it (checked byte for byte). Core improvements reach every app with `factory sync-core`. |
| `template/src/app` | The only area the agent writes: `routes.ts`, `manifest.ts` (activation event + smoke tests), `web/index.html`, `tests/app*.test.ts`. |
| `orchestrator/` | The `factory` CLI: build, validate, ship, score, iterate, kill. |
| `orchestrator/prompts` | Agent rules and prompts (build, repair, iterate). |
| `registry.json` | Portfolio state (status, URLs, agent spend, scorecards). Committed by the workflow. |
| `reports/latest.md` | Report of the last run (also written to the GitHub Actions summary). |

### Language
Code, comments, commits, folder names and docs are always **English**. Each idea has a `locale`
(`en-US` by default, or `pt-BR`) that controls only what its end users see: UI copy, error
messages, AI output and price formatting.

### Validation gates (`factory validate <slug>`)
1. **core-integrity**: core, `serverless.yml`, configs and dependencies are identical to the template.
2. **secret-scan**: no Stripe/AWS/Anthropic keys in the code.
3. **code-policy**: no `eval`, `child_process`, `innerHTML` with interpolation, new dependencies, or secrets read from `process.env`.
4. **typecheck**, **tests** (core tests, app tests, and the manifest's smoke checks in memory), **bundle** (< 2 MB), **package** (`osls package`).

When a gate fails, the agent gets the output and tries to fix it (`maxRepairAttempts`). When an
iteration on a live app fails the gates, the previous code is restored and nothing is deployed.

### Agent sandbox
The agent (Claude Agent SDK) can only write to `src/app/**` and `tests/app*.test.ts`, can only run
`npm test` / `npm run typecheck` / read-only commands, has no web access, and has a spend cap per
session (`maxBudgetUsdPerBuild`).

### Metrics and decisions
Each app writes daily counters to its own DynamoDB table: `pageview`, `signup`,
`<activationEvent>`, `checkout_started`, `subscription_activated` and `subscription_canceled`,
with per-user unique counts. Smoke-test users (`@smoke.invalid`) are excluded from metrics and
deleted at the end. Decision rules live in `factory.config.yaml` → `score`.

## Setup (once)

1. **Repository**: push this folder to a private GitHub repo (branch `main`).
2. **AWS** (creates the GitHub OIDC role, with no long-lived keys, and a budget alert):
   ```bash
   aws cloudformation deploy --stack-name mvp-factory-bootstrap \
     --template-file infra/bootstrap.yml --capabilities CAPABILITY_NAMED_IAM \
     --parameter-overrides GitHubRepo=YOUR_USER/mvp-factory BudgetEmail=you@example.com MonthlyBudgetUsd=50
   aws cloudformation describe-stacks --stack-name mvp-factory-bootstrap --query "Stacks[0].Outputs"
   ```
   If the account already has the GitHub OIDC provider, add `CreateOidcProvider=false`.
3. **Bedrock**: enable the model in `runtime.bedrockModelId` in the Bedrock console (us-east-1).
4. **GitHub secrets** (Settings → Secrets and variables → Actions):

   | Secret | Required | Used for |
   |---|---|---|
   | `AWS_ROLE_ARN` | yes | `RoleArn` output from step 2 |
   | `ANTHROPIC_API_KEY` | yes | the builder agent |
   | `STRIPE_SECRET_KEY_DEV` | recommended | `sk_test_…` (dev) |
   | `STRIPE_SECRET_KEY_PROD` | to charge | `sk_live_…` (prod) |
   | `PLUGGY_CLIENT_ID_DEV` / `PLUGGY_CLIENT_SECRET_DEV` | for br-expense-tracker | sandbox credentials |
   | `PLUGGY_CLIENT_ID_PROD` / `PLUGGY_CLIENT_SECRET_PROD` | for br-expense-tracker | production credentials |

   Secrets are stored in SSM (`/mvp/<slug>/<stage>/*`, SecureString) and read by the Lambda at
   runtime. `JWT_SECRET` and `ADMIN_TOKEN` are generated automatically, and the Stripe webhook is
   created on each stage's first deploy.
5. Done. The `factory` workflow runs daily at 06:17 (São Paulo time). To run it now:
   Actions → factory → Run workflow (`run`, `build calisthenics-coach`, `ship study-cards`, `score`…),
   or `gh workflow run factory -f command="build calisthenics-coach"`.

## Local usage

```bash
pnpm install
pnpm test                                    # orchestrator + template tests
pnpm factory list
pnpm factory run --dry-run                   # full cycle with a mock builder, no AWS
pnpm factory build calisthenics-coach        # real agent (needs ANTHROPIC_API_KEY)
cd apps/calisthenics-coach && pnpm dev       # http://localhost:3000 with an in-memory DB
pnpm factory ship calisthenics-coach         # needs AWS credentials
```

## Adding an idea
Create `ideas/<slug>.yaml` following the existing ones (schema in `orchestrator/src/ideas.ts`).
The fields with the most influence on the result are `features` (concrete scope),
`pricing.freeTier/proTier` (limits enforced server-side), `activationEvent` (the moment of real
value), `constraints` and `locale`. Lower `priority` is built first; `status: paused` skips it.

## Costs and limits
- AWS: everything is on-demand (Lambda, HTTP API, on-demand DynamoDB); close to zero without traffic. The bootstrap adds a budget alert.
- Agent: up to `maxBudgetUsdPerBuild × (1 + maxRepairAttempts)` per build. Actual spend is tracked in `registry.json`.
- Pace: `run.maxNewIdeasPerRun` and `run.maxIterationsPerRun` control how much ships per day.
- The factory **does not generate traffic**. Without visitors, apps stay in `needs-traffic`. Distribution (ads, communities, SEO) is what turns a deploy into validation.
- Health and finance apps: the prompts require a health disclaimer, privacy consent and account deletion. Have the terms of service and privacy policy reviewed before charging real money.
