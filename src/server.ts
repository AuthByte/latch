import { serve } from "@hono/node-server";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.js";
import { FilePersistence } from "./persist.js";
import { ownerFromEnv, pgStoreFromUrl } from "./env.js";
import { MemoryStore } from "./store.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const store = new MemoryStore();
const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? "127.0.0.1";
const publicBase = process.env.LATCH_BASE_URL ?? `http://127.0.0.1:${port}`;

// LATCH_DATA=":memory:" keeps the old forget-everything-on-restart behaviour.
// SUPABASE_DB_URL switches to Postgres; otherwise state is a local snapshot file.
const dbUrl = process.env.SUPABASE_DB_URL;
const dataPath = process.env.LATCH_DATA ?? "latch-data.json";
const persistence =
  dbUrl || dataPath === ":memory:" ? undefined : new FilePersistence(store, resolve(dataPath));
if (persistence?.load()) {
  console.log(`Loaded ${store.actors.size} actors from ${resolve(dataPath)}`);
}

const app = createApp({
  store: dbUrl ? pgStoreFromUrl(dbUrl) : store,
  owner: ownerFromEnv(),
  publicBase,
  webhookRetries: 3,
  opsSecret: process.env.LATCH_OPS_SECRET,
  joinCode: process.env.LATCH_JOIN_CODE,
  onMutation: persistence ? () => persistence.schedule() : undefined,
  onWebhookError: (err) =>
    console.warn(`webhook delivery failed: ${err instanceof Error ? err.message : String(err)}`),
});

app.get("/", (c) => {
  const index = join(root, "index.html");
  if (existsSync(index)) {
    return c.html(readFileSync(index, "utf8"));
  }
  return c.json({ protocol: "latch", v: 0, health: "/v0/health" });
});

app.get("/styles.css", (c) => {
  const css = join(root, "styles.css");
  if (!existsSync(css)) return c.body("not found", 404);
  return c.body(readFileSync(css, "utf8"), 200, {
    "content-type": "text/css; charset=utf-8",
  });
});

setInterval(() => {
  store.expireDue();
  persistence?.schedule();
}, 60_000).unref();

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    persistence?.flush();
    process.exit(0);
  });
}

serve({ fetch: app.fetch, port, hostname: host }, (info) => {
  console.log(`Latch v0 listening on http://${host}:${info.port}`);
  console.log(
    dbUrl
      ? "State: Postgres (SUPABASE_DB_URL)"
      : persistence
        ? `State: ${resolve(dataPath)}`
        : "State: memory only (LATCH_DATA=:memory:)",
  );
});
