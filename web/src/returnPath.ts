// Remembers where to send the user after magic-link sign-in (the OTP redirect
// always lands on /onboarding). Only same-origin invite paths (agent /i/, connection /c/) are honoured.
const KEY = "latch.return";
const RETURN_RE = /^\/[ic]\/[A-Za-z0-9_-]+$/;

export function rememberReturn(path: string): void {
  if (!RETURN_RE.test(path)) return;
  try {
    sessionStorage.setItem(KEY, path);
  } catch {
    /* ignore */
  }
}

export function peekReturn(): string | null {
  try {
    const v = sessionStorage.getItem(KEY);
    return v && RETURN_RE.test(v) ? v : null;
  } catch {
    return null;
  }
}

export function clearReturn(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

/** Supabase reports failed magic links as error_description in the URL hash/query. */
export function authErrorFromUrl(): string | null {
  const h = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const q = new URLSearchParams(window.location.search);
  const d = h.get("error_description") ?? q.get("error_description");
  return d ? d.replace(/\+/g, " ") : null;
}
