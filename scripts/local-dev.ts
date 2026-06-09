/**
 * Local dev server for testing Discord interactions without deploying.
 *
 * It runs the real Lambda command handler behind a plain HTTP server, so you can
 * point Discord's Interactions Endpoint URL at it via a tunnel (e.g. ngrok) and
 * test commands like `/gate hail` with the exact code that runs in production —
 * including real Ed25519 signature verification.
 *
 * Usage:
 *   1. npx ts-node scripts/local-dev.ts          (loads .env, listens on :3000)
 *   2. ngrok http 3000                            (in another terminal)
 *   3. Paste the https ngrok URL + "/" as the Interactions Endpoint URL in the
 *      Discord Developer Portal (it will PING to validate).
 *   4. npm run register-commands                  (so /gate appears)
 *   5. In Discord: /gate hail
 *
 * Swap the endpoint back to your API Gateway URL once deployed — same handler.
 */
import * as http from "http";

// Load .env BEFORE requiring the handler, so GAME / DISCORD_BOT_PUBLIC_KEY are set
// when the games registry + persona initialize.
try {
  (process as unknown as { loadEnvFile: () => void }).loadEnvFile();
} catch {
  console.warn("Could not load .env automatically — relying on existing env vars.");
}

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handler } = require("../lib/lambdas/commands");

const PORT = Number(process.env.LOCAL_PORT) || 3000;

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", async () => {
    // Adapt the raw HTTP request into the APIGatewayProxyEvent shape the handler
    // expects. The raw body string is required for signature verification.
    const event = {
      httpMethod: req.method,
      headers: req.headers,
      body,
    };
    try {
      const result = await handler(event, {});
      res.writeHead(result.statusCode || 200, {
        "Content-Type": "application/json",
        ...(result.headers || {}),
      });
      res.end(result.body || "");
    } catch (err) {
      console.error("Handler error:", err);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Internal server error" }));
    }
  });
});

server.listen(PORT, () => {
  console.log(`🛰️  GATEKeeper local dev server on http://localhost:${PORT}`);
  console.log(`   Game: ${process.env.GAME || "abiotic-factor"}`);
  console.log(`   Public key set: ${process.env.DISCORD_BOT_PUBLIC_KEY ? "yes" : "NO — verification will fail"}`);
  console.log(`   Next: run \`ngrok http ${PORT}\` and set that URL as the Discord Interactions Endpoint.`);
});
