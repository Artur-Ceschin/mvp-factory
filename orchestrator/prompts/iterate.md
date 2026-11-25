This app is live in production. Improve it based on real usage data.

## Scorecard (last {{WINDOW}} days)

{{SCORECARD}}

## Daily metrics

```json
{{DAILY}}
```

## Factory decision: {{DECISION}}

{{FOCUS}}

Make 1–3 focused changes that most improve the weakest step of the funnel
(visit → signup → activation → paid). Explain the hypothesis behind each change in your final
summary so the next scorecard can confirm or reject it. Keep existing users' data compatible:
never change the pk/sk layout of data that already exists. Track any new key step with
`track()` (server-side) or `App.track("ui_...")` (browser).

When done, `npm run typecheck` and `npm test` must both pass.
