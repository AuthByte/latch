import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ApiError, getMe, type Me } from "./api";
import { useAuth } from "./auth";

type MeState = {
  me: Me | null;
  error: ApiError | null;
  loading: boolean;
  /** Re-fetch. `silent` keeps existing data on screen without toggling loading. */
  refresh: (silent?: boolean) => Promise<Me | null>;
};

const Ctx = createContext<MeState | null>(null);

/** Mounted only for signed-in routes; owns the GET /v0/owner/me snapshot. */
export function MeProvider({ children }: { children: ReactNode }) {
  const { signedIn, signOut } = useAuth();
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(true);
  const seq = useRef(0);

  const refresh = useCallback(
    async (silent = false) => {
      const n = ++seq.current;
      if (!silent) setLoading(true);
      try {
        const data = await getMe();
        if (n === seq.current) {
          setMe(data);
          setError(null);
        }
        return data;
      } catch (e) {
        const err = e instanceof ApiError ? e : new ApiError(0, "error", "Could not load your account.");
        if (n === seq.current) {
          if (err.status === 401 && !silent) void signOut();
          setError(err);
        }
        return null;
      } finally {
        if (n === seq.current) setLoading(false);
      }
    },
    [signOut],
  );

  useEffect(() => {
    if (signedIn) void refresh();
  }, [signedIn, refresh]);

  const value = useMemo(() => ({ me, error, loading, refresh }), [me, error, loading, refresh]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useMe(): MeState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useMe outside MeProvider");
  return v;
}
