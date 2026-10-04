import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { setTokenGetter } from "./api";
import { DEV_AUTH, loadConfig } from "./config";

type AuthState = {
  /** "loading" until config + initial session are resolved. */
  status: "loading" | "ready";
  signedIn: boolean;
  email: string | null;
  /** True when no Supabase config could be found (and dev auth is off). */
  misconfigured: boolean;
  devAuth: boolean;
  sendMagicLink: (email: string) => Promise<void>;
  devSignIn: (email: string) => void;
  signOut: () => Promise<void>;
};

const Ctx = createContext<AuthState | null>(null);
const DEV_KEY = "latch.dev.email";

function readDevEmail(): string | null {
  if (!DEV_AUTH) return null;
  try {
    return sessionStorage.getItem(DEV_KEY);
  } catch {
    return null;
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<"loading" | "ready">("loading");
  const [email, setEmail] = useState<string | null>(null);
  const [devEmail, setDevEmail] = useState<string | null>(readDevEmail);
  const [misconfigured, setMisconfigured] = useState(false);
  const sb = useRef<SupabaseClient | null>(null);
  const devRef = useRef(devEmail);
  devRef.current = devEmail;

  useEffect(() => {
    setTokenGetter(async () => {
      if (devRef.current) return `dev:${devRef.current}`;
      const client = sb.current;
      if (!client) return null;
      const { data } = await client.auth.getSession();
      return data.session?.access_token ?? null;
    });
  }, []);

  useEffect(() => {
    let unsub: (() => void) | undefined;
    let alive = true;
    (async () => {
      const cfg = await loadConfig();
      if (!alive) return;
      if (cfg.supabase_url && cfg.supabase_publishable_key) {
        const { createClient } = await import("@supabase/supabase-js");
        if (!alive) return;
        const client = createClient(cfg.supabase_url, cfg.supabase_publishable_key, {
          auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
        });
        sb.current = client;
        // getSession resolves after any URL-hash/code exchange completes.
        const { data } = await client.auth.getSession();
        if (!alive) return;
        setEmail(data.session?.user.email ?? null);
        const { data: sub } = client.auth.onAuthStateChange((_evt, session) => {
          setEmail(session?.user.email ?? null);
        });
        unsub = () => sub.subscription.unsubscribe();
      } else if (!DEV_AUTH) {
        setMisconfigured(true);
      }
      setStatus("ready");
    })();
    return () => {
      alive = false;
      unsub?.();
    };
  }, []);

  const sendMagicLink = useCallback(async (to: string) => {
    const client = sb.current;
    if (!client) throw new Error("Sign-in is not configured on this server.");
    const { error } = await client.auth.signInWithOtp({
      email: to,
      options: { emailRedirectTo: `${window.location.origin}/onboarding` },
    });
    if (error) throw new Error(error.message);
  }, []);

  const devSignIn = useCallback((to: string) => {
    try {
      sessionStorage.setItem(DEV_KEY, to);
    } catch {
      /* ignore */
    }
    setDevEmail(to);
  }, []);

  const signOut = useCallback(async () => {
    try {
      sessionStorage.removeItem(DEV_KEY);
    } catch {
      /* ignore */
    }
    setDevEmail(null);
    if (sb.current) await sb.current.auth.signOut();
    setEmail(null);
  }, []);

  const value = useMemo<AuthState>(
    () => ({
      status,
      signedIn: Boolean(devEmail || email),
      email: devEmail ?? email,
      misconfigured,
      devAuth: DEV_AUTH,
      sendMagicLink,
      devSignIn,
      signOut,
    }),
    [status, devEmail, email, misconfigured, sendMagicLink, devSignIn, signOut],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useAuth outside AuthProvider");
  return v;
}
