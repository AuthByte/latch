import { useState, type FormEvent } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "../auth";
import { useAction } from "../hooks";
import { ErrorNote, InfoNote, PageLoading } from "../components/ui";
import { authErrorFromUrl, rememberReturn, peekReturn } from "../returnPath";

export function Start() {
  const auth = useAuth();
  const loc = useLocation();
  const st = loc.state as { from?: string; authError?: string } | null;
  const from = st?.from;
  const [email, setEmail] = useState("");
  const [devEmail, setDevEmail] = useState("");
  const [sent, setSent] = useState<string | null>(null);
  const [linkError] = useState(() => st?.authError ?? authErrorFromUrl());
  const send = useAction(async (to: string) => {
    if (from) rememberReturn(from);
    await auth.sendMagicLink(to);
    setSent(to);
  });

  if (auth.status === "loading") return <PageLoading label="Loading" />;
  if (auth.signedIn) return <Navigate to={peekReturn() ?? from ?? "/onboarding"} replace />;

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    const v = email.trim();
    if (v) void send.run(v);
  }

  return (
    <section className="card narrow">
      <p className="eyebrow">Step 0 &middot; Sign in</p>
      <h1 className="h-page">Start with your email.</h1>
      <p className="muted">
        No password. We email you a one-time link; opening it signs you in. You&rsquo;ll then name your agent and
        run one command where it lives.
      </p>

      {from?.startsWith("/i/") ? (
        <InfoNote>Sign in to accept the invite you opened. You&rsquo;ll come right back to it.</InfoNote>
      ) : null}
      {linkError ? <ErrorNote message={`That sign-in link didn't work: ${linkError}. Request a new one below.`} /> : null}

      {auth.misconfigured ? (
        <ErrorNote message="Sign-in isn't configured on this server yet (no Supabase settings found)." />
      ) : sent ? (
        <div className="sent" aria-live="polite">
          <h2>Check your inbox</h2>
          <p>
            We sent a sign-in link to <strong className="mono">{sent}</strong>. Open it on this device. It
            expires shortly and works once.
          </p>
          <button type="button" className="btn btn-ghost" onClick={() => setSent(null)}>
            Use a different email
          </button>
        </div>
      ) : (
        <form onSubmit={onSubmit} className="form" noValidate={false}>
          <label className="field">
            <span className="label">Email</span>
            <input
              type="email"
              name="email"
              autoComplete="email"
              inputMode="email"
              required
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>
          <ErrorNote message={send.error} />
          <button className="btn btn-primary" type="submit" disabled={send.busy || !email.trim()}>
            {send.busy ? "Sending…" : "Email me a sign-in link"}
          </button>
        </form>
      )}

      {auth.devAuth ? (
        <form
          className="form dev-box"
          onSubmit={(e) => {
            e.preventDefault();
            if (devEmail.trim()) auth.devSignIn(devEmail.trim());
          }}
        >
          <p className="eyebrow">Dev sign in</p>
          <p className="hint">Local only. Needs LATCH_DEV_OWNERS=1 on the server.</p>
          <label className="field">
            <span className="label">Dev email</span>
            <input
              type="email"
              required
              placeholder="dev@example.com"
              value={devEmail}
              onChange={(e) => setDevEmail(e.target.value)}
            />
          </label>
          <button className="btn btn-ghost" type="submit">
            Dev sign in
          </button>
        </form>
      ) : null}
    </section>
  );
}
