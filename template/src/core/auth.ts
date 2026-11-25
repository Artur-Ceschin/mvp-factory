// Email + password auth with scrypt hashes and HS256 JWTs (no external deps).
// CORE FILE — generated apps must not edit anything under src/core.
import { createHmac, randomBytes, scrypt as _scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { ConflictError, db, id, now } from "./db.js";
import { SMOKE_PREFIX, track } from "./events.js";
import { HttpError, json, requireFields, type Req, type Router, type User } from "./http.js";
import { t } from "./i18n.js";
import { requireSecret } from "./secrets.js";

const scrypt = promisify(_scrypt) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;
const TOKEN_TTL_S = 60 * 60 * 24 * 30;
const MAX_FAILED_PER_HOUR = 10;

type UserItem = User & { pk: string; sk: string; passwordHash: string; stripeCustomerId?: string; [k: string]: unknown };

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");

async function hashPassword(pw: string) {
  const salt = randomBytes(16);
  const hash = await scrypt(pw, salt, 64);
  return `${salt.toString("hex")}:${hash.toString("hex")}`;
}

async function verifyPassword(pw: string, stored: string) {
  const [saltHex, hashHex] = stored.split(":");
  if (!saltHex || !hashHex) return false;
  const hash = await scrypt(pw, Buffer.from(saltHex, "hex"), 64);
  return timingSafeEqual(hash, Buffer.from(hashHex, "hex"));
}

export async function signToken(userId: string) {
  const secret = await requireSecret("JWT_SECRET");
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({ sub: userId, exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_S }),
  );
  const sig = createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${sig}`;
}

export async function verifyToken(token: string): Promise<string | undefined> {
  const [h, p, s] = token.split(".");
  if (!h || !p || !s) return undefined;
  const secret = await requireSecret("JWT_SECRET");
  const expected = createHmac("sha256", secret).update(`${h}.${p}`).digest();
  const got = Buffer.from(s, "base64url");
  if (got.length !== expected.length || !timingSafeEqual(got, expected)) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(p, "base64url").toString());
    if (typeof payload.exp !== "number" || payload.exp < Date.now() / 1000) return undefined;
    return typeof payload.sub === "string" ? payload.sub : undefined;
  } catch {
    return undefined;
  }
}

const userKey = (userId: string) => ({ pk: `USER#${userId}`, sk: "PROFILE" });
const emailKey = (email: string) => ({ pk: `EMAIL#${email}`, sk: "EMAIL" });

export async function getUser(userId: string): Promise<User | undefined> {
  const k = userKey(userId);
  const item = await db().get<UserItem>(k.pk, k.sk);
  return item ? publicUser(item) : undefined;
}

export async function setPlan(userId: string, plan: User["plan"], extra: Record<string, unknown> = {}) {
  const k = userKey(userId);
  await db().patch(k.pk, k.sk, { plan, ...extra });
}

function publicUser(u: UserItem): User {
  return { id: u.id, email: u.email, plan: u.plan, createdAt: u.createdAt };
}

export async function authenticate(req: Req): Promise<User | undefined> {
  const h = req.headers["authorization"] ?? "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : undefined;
  if (!token) return undefined;
  const userId = await verifyToken(token);
  return userId ? getUser(userId) : undefined;
}

function normalizeEmail(e: string) {
  const email = e.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200)
    throw new HttpError(400, t("invalid_email"), "invalid_email");
  return email;
}

export function registerAuthRoutes(r: Router) {
  r.post("/api/auth/signup", async (req) => {
    const body = requireFields(req.body, { email: "string", password: "string" });
    const email = normalizeEmail(body.email);
    if (body.password.length < 8) throw new HttpError(400, t("weak_password"), "weak_password");
    // Factory smoke tests sign up as *@smoke.invalid; those users are excluded from metrics.
    const userId = email.endsWith("@smoke.invalid") ? `${SMOKE_PREFIX}${id()}` : id();
    try {
      await db().put({ ...emailKey(email), userId }, { ifNotExists: true });
    } catch (e) {
      if (e instanceof ConflictError) throw new HttpError(409, t("email_taken"), "email_taken");
      throw e;
    }
    const user: UserItem = {
      ...userKey(userId),
      id: userId,
      email,
      plan: "free",
      createdAt: now(),
      passwordHash: await hashPassword(body.password),
    };
    await db().put(user);
    await track("signup", userId);
    return json({ token: await signToken(userId), user: publicUser(user) }, 201);
  });

  r.post("/api/auth/login", async (req) => {
    const body = requireFields(req.body, { email: "string", password: "string" });
    const email = normalizeEmail(body.email);
    const hour = new Date().toISOString().slice(0, 13);
    const throttle = await db().get(`THROTTLE#${email}`, hour);
    if (((throttle?.failed as number) ?? 0) >= MAX_FAILED_PER_HOUR)
      throw new HttpError(429, t("rate_limited"), "rate_limited");
    const ref = await db().get(emailKey(email).pk, "EMAIL");
    const user = ref ? await db().get<UserItem>(`USER#${ref.userId}`, "PROFILE") : undefined;
    if (!user || !(await verifyPassword(body.password, user.passwordHash))) {
      await db().increment(`THROTTLE#${email}`, hour, { failed: 1 });
      throw new HttpError(401, t("invalid_credentials"), "invalid_credentials");
    }
    await track("login", user.id);
    return json({ token: await signToken(user.id), user: publicUser(user) });
  });

  r.get("/api/auth/me", async (req) => json({ user: req.user }), "user");

  // LGPD: users can delete their account and every item stored under USER#<id>.
  // Apps must keep all personal data under pk=USER#<id> so this stays complete.
  r.delete(
    "/api/auth/me",
    async (req) => {
      const user = req.user!;
      const items = await db().query(`USER#${user.id}`);
      for (const it of items) await db().delete(it.pk, it.sk);
      await db().delete(emailKey(user.email).pk, "EMAIL");
      return json({ deleted: true });
    },
    "user",
  );
}
