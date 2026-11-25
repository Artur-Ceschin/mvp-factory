# MVP Factory

Fábrica autônoma de MVPs pagos. Ela pega ideias de `ideas/*.yaml` e, com um agente Claude,
gera cada app funcional, valida, publica na AWS (Lambda + DynamoDB via Serverless Framework),
mede o uso real em produção e decide o que fazer com cada app: **iterar**, **escalar** ou **matar**.

```
ideas/*.yaml ──► build (agente Claude) ──► gates ──✗──► repair (agente) ─┐
                                             │ ✓                        │ até N vezes
                                             ▼                          │
                       deploy dev ──► smoke ──► deploy prod ──► smoke ◄─┘
                                                                  │
                     score diário (/api/_metrics) ◄───────────────┘
                       │
       scale / iterate ──► agente melhora o funil ──► gates ──► deploy
       needs-traffic   ──► só reporta (sem tráfego não há validação)
       kill-candidate  ──► abre issue (ou remove, se autoKill: true)
```

## Como funciona

| Peça | O que faz |
|---|---|
| `template/` | App base que todo MVP herda: auth (e-mail/senha, JWT), Stripe Checkout + webhooks, analytics, IA via Bedrock, Open Finance via Pluggy, exclusão de conta (LGPD), SPA servida pela própria Lambda. |
| `template/src/core` | **Protegido.** O agente não pode alterar (checado byte a byte). Melhorias no core chegam a todos os apps com `factory sync-core`. |
| `template/src/app` | Única área que o agente escreve: `routes.ts`, `manifest.ts` (evento de ativação + smoke tests), `web/index.html`, `tests/app*.test.ts`. |
| `orchestrator/` | CLI `factory`: build, validate, ship, score, iterate, kill. |
| `orchestrator/prompts` | Regras e prompts do agente (build, repair, iterate). |
| `registry.json` | Estado do portfólio (status, URLs, gasto com agente, scorecards). Commitado pelo workflow. |
| `reports/latest.md` | Relatório da última execução (também vai para o summary do GitHub Actions). |

### Gates de validação (`factory validate <slug>`)
1. **core-integrity**: core, `serverless.yml`, configs e dependências idênticos ao template.
2. **secret-scan**: nenhuma chave Stripe/AWS/Anthropic no código.
3. **code-policy**: sem `eval`, `child_process`, `innerHTML` com interpolação, dependências novas ou segredos lidos de `process.env`.
4. **typecheck**, **tests** (testes do core + do app + smoke tests do manifest em memória), **bundle** (< 2 MB), **package** (`osls package`).

Se um gate falha, o agente recebe a saída e tenta corrigir (`maxRepairAttempts`). Numa iteração de
app em produção que não passa nos gates, o código anterior é restaurado e nada é publicado.

### Sandbox do agente
O agente (Claude Agent SDK) só escreve em `src/app/**` e `tests/app*.test.ts`, só roda
`npm test` / `npm run typecheck` / comandos de leitura, não tem acesso à web e tem teto de gasto
por sessão (`maxBudgetUsdPerBuild`).

### Métricas e decisão
Cada app grava contadores diários no próprio DynamoDB: `pageview`, `signup`, `<activationEvent>`,
`checkout_started`, `subscription_activated` e `subscription_canceled`, com contagem única por
usuário. Usuários de smoke test (`@smoke.invalid`) ficam fora das métricas e são apagados ao final.
As regras de decisão ficam em `factory.config.yaml` → `score`.

## Setup (uma vez)

1. **Repositório**: suba esta pasta para um repo GitHub privado (branch `main`).
2. **AWS** (cria a role OIDC do GitHub, sem chaves de longa duração, e um alerta de orçamento):
   ```bash
   aws cloudformation deploy --stack-name mvp-factory-bootstrap \
     --template-file infra/bootstrap.yml --capabilities CAPABILITY_NAMED_IAM \
     --parameter-overrides GitHubRepo=SEU_USUARIO/mvp-factory BudgetEmail=voce@email.com MonthlyBudgetUsd=50
   aws cloudformation describe-stacks --stack-name mvp-factory-bootstrap --query "Stacks[0].Outputs"
   ```
   Se a conta já tem o provider OIDC do GitHub, use `CreateOidcProvider=false`.
3. **Bedrock**: habilite o modelo de `runtime.bedrockModelId` no console do Bedrock (us-east-1).
4. **Secrets do GitHub** (Settings → Secrets and variables → Actions):

   | Secret | Obrigatório | Uso |
   |---|---|---|
   | `AWS_ROLE_ARN` | sim | output `RoleArn` do passo 2 |
   | `ANTHROPIC_API_KEY` | sim | agente construtor |
   | `STRIPE_SECRET_KEY_DEV` | recomendado | `sk_test_…` (dev) |
   | `STRIPE_SECRET_KEY_PROD` | para cobrar | `sk_live_…` (prod) |
   | `PLUGGY_CLIENT_ID_DEV` / `PLUGGY_CLIENT_SECRET_DEV` | para o Grana Clara | credenciais sandbox |
   | `PLUGGY_CLIENT_ID_PROD` / `PLUGGY_CLIENT_SECRET_PROD` | para o Grana Clara | credenciais de produção |

   Os segredos vão para o SSM (`/mvp/<slug>/<stage>/*`, SecureString). A Lambda lê de lá em runtime.
   `JWT_SECRET` e `ADMIN_TOKEN` são gerados automaticamente e o webhook do Stripe é criado sozinho
   no primeiro deploy de cada stage.
5. Pronto. O workflow `factory` roda todo dia às 06:17 (horário de Brasília). Para rodar na hora:
   Actions → factory → Run workflow (`run`, `build calistenia-coach`, `ship estudo-ativo`, `score`…).

## Uso local

```bash
npm install
npm test                                      # testes do orquestrador + template
npx tsx orchestrator/src/cli.ts list
npx tsx orchestrator/src/cli.ts run --dry-run   # ciclo completo com builder simulado, sem AWS
npx tsx orchestrator/src/cli.ts build calistenia-coach          # agente real (ANTHROPIC_API_KEY)
cd apps/calistenia-coach && npm run dev        # http://localhost:3000 com DB em memória
npx tsx orchestrator/src/cli.ts ship calistenia-coach            # precisa de credenciais AWS
```

## Adicionar uma ideia
Crie `ideas/<slug>.yaml` seguindo os existentes (schema em `orchestrator/src/ideas.ts`). Campos que
mais influenciam o resultado são `features` (escopo concreto), `pricing.freeTier/proTier` (limites
aplicados no servidor), `activationEvent` (o momento de valor real) e `constraints`.
`priority` menor é construído primeiro; `status: paused` pula a ideia.

## Custos e limites
- AWS: tudo on-demand (Lambda, HTTP API, DynamoDB on-demand); sem tráfego fica perto de zero. Há o alerta de orçamento do bootstrap.
- Agente: até `maxBudgetUsdPerBuild × (1 + maxRepairAttempts)` por build. O gasto real fica em `registry.json`.
- Ritmo: `run.maxNewIdeasPerRun` e `run.maxIterationsPerRun` controlam quanto sai por dia.
- A fábrica **não gera tráfego**. Sem visitantes, os apps ficam em `needs-traffic`. Divulgação (anúncios, comunidades, SEO) é o que transforma deploy em validação.
- Apps de saúde e finanças: os prompts exigem aviso de saúde, consentimento LGPD e exclusão de conta. Revise textos legais (termos e privacidade) antes de cobrar de verdade.
