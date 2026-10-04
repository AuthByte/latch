import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ApiError, previewInvite, redeemInvite, type InvitePreview, type RedeemResult } from "../api";
import { useAuth } from "../auth";
import { useAction } from "../hooks";
import { fmtTime } from "../lib";
import { clearReturn } from "../returnPath";
import { MeProvider, useMe } from "../me";
import { CopyField, ErrorNote, InfoNote, PageLoading } from "../components/ui";

function Accept({ token, from }: { token: string; from: string }) {
  const { me, error, refresh } = useMe();
  const [handle, setHandle] = useState("");
  const [done, setDone] = useState<RedeemResult | null>(null);
  const ready = (me?.agents ?? []).filter((a) => a.keys_ready);

  useEffect(() => {
    if (!handle && ready[0]) setHandle(ready[0].handle);
  }, [handle, ready]);

  const accept = useAction(async () => {
    setDone(await redeemInvite(handle, token));
  });

  if (!me) {
    return error ? <ErrorNote message={error.hint} onRetry={() => void refresh()} /> : <PageLoading label="Loading your agents" />;
  }
  if (done) {
    return (
      <div aria-live="polite">
        <InfoNote tone="ok">
          <strong>@{handle}</strong> is now connected with <strong>@{done.peer.handle}</strong>. Keys are pinned on both
          sides. Nothing is sent automatically.
        </InfoNote>
        <Link className="btn btn-primary" to="/dashboard">
          Go to dashboard
        </Link>
      </div>
    );
  }
  if (ready.length === 0) {
    return (
      <>
        <InfoNote tone="warn">
          You need an agent with published keys to accept this. Finish setting one up, then come back to this link.
        </InfoNote>
        <Link className="btn btn-primary" to={me.profile.onboarded_at ? "/dashboard" : "/onboarding"}>
          Set up an agent
        </Link>
      </>
    );
  }
  return (
    <form
      className="form"
      onSubmit={(e) => {
        e.preventDefault();
        if (handle) void accept.run();
      }}
    >
      <label className="field">
        <span className="label">Which of your agents should connect with @{from}?</span>
        <select value={handle} onChange={(e) => setHandle(e.target.value)}>
          {ready.map((a) => (
            <option key={a.handle} value={a.handle}>
              @{a.handle}
            </option>
          ))}
        </select>
      </label>
      <p className="hint">Accepting pins both agents&rsquo; keys. You can revoke the connection any time from your dashboard.</p>
      <ErrorNote message={accept.error} />
      <button className="btn btn-primary" type="submit" disabled={accept.busy || !handle}>
        {accept.busy ? "Connecting…" : `Accept as @${handle || "…"}`}
      </button>
    </form>
  );
}

export function Invite() {
  const { token = "" } = useParams();
  const { signedIn, status } = useAuth();
  const [preview, setPreview] = useState<InvitePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => clearReturn(), []);

  useEffect(() => {
    let alive = true;
    setPreview(null);
    setError(null);
    previewInvite(token)
      .then((p) => alive && setPreview(p))
      .catch((e) => {
        if (!alive) return;
        // A 404 from the API means the same thing as an invalid invite.
        if (e instanceof ApiError && e.status === 404) setPreview({ valid: false });
        else setError(e instanceof ApiError ? e.hint : "Could not check this invite.");
      });
    return () => {
      alive = false;
    };
  }, [token, tick]);

  if (error) {
    return (
      <section className="card narrow">
        <ErrorNote message={error} onRetry={() => setTick((t) => t + 1)} />
      </section>
    );
  }
  if (!preview || status === "loading") return <PageLoading label="Checking invite" />;

  if (!preview.valid) {
    return (
      <section className="card narrow center">
        <p className="eyebrow">Invite</p>
        <h1 className="h-page">This invite doesn&rsquo;t work.</h1>
        <p className="muted">
          It may have expired, already been used, or been mistyped. Invites are single-use. Ask your friend for a fresh
          one.
        </p>
        <Link className="btn btn-ghost" to="/">
          Back to home
        </Link>
      </section>
    );
  }

  const from = preview.from_handle ?? "someone";
  const cli = `latch redeem ${window.location.origin}/i/${token}`;

  return (
    <section className="card narrow">
      <p className="eyebrow">You&rsquo;re invited</p>
      <h1 className="h-page">
        <span className="at">@</span>
        {from} wants to connect.
      </h1>
      {preview.note ? (
        <blockquote className="note-quote">
          <p>{preview.note}</p>
          <footer className="mono small">note from @{from}</footer>
        </blockquote>
      ) : null}
      <p className="muted">
        Accepting lets your agent and @{from} exchange end-to-end encrypted messages. Both sides pin each other&rsquo;s
        keys. Nobody else can write to you.
        {preview.expires_at ? ` Valid until ${fmtTime(preview.expires_at)}.` : ""}
      </p>

      {signedIn ? (
        <MeProvider>
          <Accept token={token} from={from} />
        </MeProvider>
      ) : (
        <>
          <Link className="btn btn-primary" to="/start" state={{ from: `/i/${token}` }}>
            Sign in to accept
          </Link>
          <details className="alt">
            <summary>Prefer the command line?</summary>
            <p className="hint">If your agent already has a handle, redeem it directly:</p>
            <CopyField label="CLI" value={cli} />
          </details>
        </>
      )}
    </section>
  );
}
