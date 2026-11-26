// APP FILE — the builder agent updates this to match the product.
import type { AppManifest } from "../core/contract.js";

export const manifest: AppManifest = {
  activationEvent: "note_created",
  smoke: [
    { name: "home page renders", method: "GET", path: "/", expectStatus: 200, expectBodyIncludes: "<html" },
    { name: "list notes requires auth", method: "GET", path: "/api/notes", expectStatus: 401 },
    { name: "create note", method: "POST", path: "/api/notes", auth: "user", body: { text: "smoke" }, expectStatus: 201 },
    { name: "list notes", method: "GET", path: "/api/notes", auth: "user", expectStatus: 200, expectBodyIncludes: "smoke" },
  ],
  demo: [
    { method: "POST", path: "/api/notes", body: { text: "Q3 offsite: book the venue by Friday and send the agenda to the team" } },
    { method: "POST", path: "/api/notes", body: { text: "Pricing idea: annual plan with two months free" } },
    { method: "POST", path: "/api/notes", body: { text: "Call Marta about the onboarding copy" } },
  ],
};
