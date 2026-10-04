import postgres from "postgres";
import { devVerifier, supabaseVerifier, type OwnerOptions } from "./owner.js";
import { PgStore, postgresJsDb } from "./pg-store.js";

/** Shared env wiring for the Node server and the Vercel function. */

export function ownerFromEnv(env = process.env): Partial<Omit<OwnerOptions, "store" | "publicBase">> {
  const supabaseUrl = env.SUPABASE_URL;
  const key = env.SUPABASE_PUBLISHABLE_KEY;
  const real = supabaseUrl && key ? supabaseVerifier(supabaseUrl, key) : undefined;
  const verify = env.LATCH_DEV_OWNERS === "1" ? devVerifier(real) : real;
  return {
    verify,
    supabaseUrl,
    supabasePublishableKey: key,
    cliCommand: env.LATCH_CLI_COMMAND,
  };
}

/**
 * Supabase Postgres via the pooler. Use the transaction-mode pooler URL
 * (port 6543) on serverless; prepared statements are off for it.
 */
export function pgStoreFromUrl(url: string): PgStore {
  const sql = postgres(url, { prepare: false, max: 5, idle_timeout: 20, connect_timeout: 10 });
  return new PgStore(postgresJsDb(sql as never));
}
