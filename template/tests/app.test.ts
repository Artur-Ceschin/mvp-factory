// APP FILE — the builder agent replaces this with tests for the product's features.
import { beforeEach, describe, expect, it } from "vitest";
import { setPlan } from "../src/core/auth.js";
import { call, resetDb, signup } from "./helpers.js";

beforeEach(resetDb);

describe("notes", () => {
  it("free plan is limited, pro is not", async () => {
    const { token, user } = await signup();
    for (let i = 0; i < 5; i++) expect((await call("POST", "/api/notes", { token, body: { text: `n${i}` } })).status).toBe(201);
    expect((await call("POST", "/api/notes", { token, body: { text: "n6" } })).status).toBe(402);
    await setPlan(user.id, "pro");
    expect((await call("POST", "/api/notes", { token, body: { text: "n6" } })).status).toBe(201);
    expect((await call("GET", "/api/notes", { token })).body.notes).toHaveLength(6);
  });

  it("users only see their own notes", async () => {
    const a = await signup();
    const b = await signup();
    await call("POST", "/api/notes", { token: a.token, body: { text: "secret" } });
    expect((await call("GET", "/api/notes", { token: b.token })).body.notes).toHaveLength(0);
  });
});
