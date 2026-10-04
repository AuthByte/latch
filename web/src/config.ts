import { getConfig, type PublicConfig } from "./api";

let cached: Promise<PublicConfig> | null = null;

/** Boot config from /v0/config, falling back to Vite env vars. */
export function loadConfig(): Promise<PublicConfig> {
  cached ??= (async () => {
    const fallback: PublicConfig = {
      supabase_url: import.meta.env.VITE_SUPABASE_URL ?? "",
      supabase_publishable_key: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? "",
      base_url: window.location.origin,
    };
    try {
      const c = await getConfig();
      return {
        supabase_url: c.supabase_url || fallback.supabase_url,
        supabase_publishable_key: c.supabase_publishable_key || fallback.supabase_publishable_key,
        base_url: c.base_url || fallback.base_url,
      };
    } catch {
      return fallback;
    }
  })();
  return cached;
}

export const DEV_AUTH = import.meta.env.VITE_DEV_AUTH === "1";
