// APP FILE — the builder agent replaces this with the product's real API.
// Placeholder product: a minimal notes app that shows every pattern the core supports.
import { db, id, now } from "../core/db.js";
import { track } from "../core/events.js";
import { HttpError, json, requireFields, type Router } from "../core/http.js";

const FREE_LIMIT = 5;

export function registerAppRoutes(r: Router) {
  r.get(
    "/api/notes",
    async (req) => json({ notes: await db().query(`USER#${req.user!.id}`, { prefix: "NOTE#", newestFirst: true }) }),
    "user",
  );

  r.post(
    "/api/notes",
    async (req) => {
      const { text } = requireFields(req.body, { text: "string" });
      if (!text.trim() || text.length > 2000) throw new HttpError(400, "Texto inválido", "bad_request");
      const user = req.user!;
      if (user.plan !== "pro") {
        const existing = await db().query(`USER#${user.id}`, { prefix: "NOTE#" });
        if (existing.length >= FREE_LIMIT)
          throw new HttpError(402, `O plano grátis permite ${FREE_LIMIT} notas`, "payment_required");
      }
      const note = { pk: `USER#${user.id}`, sk: `NOTE#${now()}#${id()}`, text: text.trim(), createdAt: now() };
      await db().put(note);
      await track("note_created", user.id);
      return json({ note }, 201);
    },
    "user",
  );

  // Example of a paid-only feature.
  r.get("/api/notes/export", async (req) => {
    const notes = await db().query(`USER#${req.user!.id}`, { prefix: "NOTE#" });
    return json({ export: notes.map((n) => n.text) });
  }, "pro");
}
