import { handle } from "@hono/node-server/vercel";
import { waitUntil } from "@vercel/functions";
import { createApp } from "./app.js";
import { ownerFromEnv, pgStoreFromUrl } from "./env.js";

const dbUrl = process.env.SUPABASE_DB_URL;
if (!dbUrl) throw new Error("SUPABASE_DB_URL is not set");

const app = createApp({
  store: pgStoreFromUrl(dbUrl),
  publicBase:
    process.env.LATCH_BASE_URL ??
    (process.env.VERCEL_PROJECT_PRODUCTION_URL
      ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
      : "http://127.0.0.1:8787"),
  webhookRetries: 3,
  opsSecret: process.env.LATCH_OPS_SECRET,
  joinCode: process.env.LATCH_JOIN_CODE,
  waitUntil,
  onWebhookError: (err) =>
    console.warn(`webhook delivery failed: ${err instanceof Error ? err.message : String(err)}`),
  owner: ownerFromEnv(),
});

export default handle(app);
