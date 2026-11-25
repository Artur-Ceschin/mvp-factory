// Local dev server: bundles the Lambda and serves it on http://localhost:3000 with an in-memory DB.
import { execSync } from "node:child_process";
import { createServer } from "node:http";

process.env.JWT_SECRET ??= "dev-secret";
process.env.ADMIN_TOKEN ??= "dev-admin";
execSync("node build.mjs", { stdio: "inherit" });
const { handler } = await import(`./dist/handler.mjs?t=${Date.now()}`);

createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const url = new URL(req.url ?? "/", "http://localhost");
  const out = await handler({
    rawPath: url.pathname,
    queryStringParameters: Object.fromEntries(url.searchParams),
    headers: req.headers,
    body: Buffer.concat(chunks).toString(),
    isBase64Encoded: false,
    requestContext: { http: { method: req.method } },
  });
  res.writeHead(out.statusCode, out.headers);
  res.end(out.body);
}).listen(3000, () => console.log("dev server on http://localhost:3000"));
