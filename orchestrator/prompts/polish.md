The design reviewer scored the app {{SCORE}}/10; it must reach at least {{MIN_SCORE}}/10.

Reviewer summary: {{SUMMARY}}

Screenshots of the current version (open them with the Read tool before changing anything):
{{SCREENSHOTS}}

Issues, highest severity first:

{{ISSUES}}

Fix the issues in this order, highest severity first, by changing `src/app/web/theme.css` and
`src/app/web/index.html` (and `manifest.demo` if the logged-in screen lacks realistic data).
Follow SPEC.md's Visual identity and the Design rules.

- Do not change behavior: same routes, same element IDs and flows, same API calls.
- Do not break or weaken tests; when done, `npm run typecheck` and `npm test` must both pass.
- Prefer a few deliberate, consistent changes over many small tweaks.
