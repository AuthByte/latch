import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { acceptConnection, ApiError, previewConnection, type ConnectionPreview } from "../api";
import { useAuth } from "../auth";
import { useAction } from "../hooks";
import { fmtTime } from "../lib";
import { clearReturn } from "../returnPath";
import { MeProvider, useMe } from "../me";
import { UsernamePicker } from "../components/Username";
import { ErrorNote, InfoNote, PageLoading } from "../components/ui";

function Accept({ token, from }: { token: string; from: string }) {
  const { me, error, refresh } = useMe();
  const nav = useNavigate();
  const accept = useAction(async () => {
    const conn = await acceptConnection(token);
    nav("/people", { state: { connected: conn.peer.username } });
  });

  if (!me) {
    return error ? <ErrorNote message={error.hint} onRetry={() => void refresh()} /> : <PageLoading label="Loading your account" />;
  }
  if (!me.username) {
    return (
      <>
        <InfoNote tone="warn">
          Pick your username first, so @{from} sees who they&rsquo;re connecting with. You pick it once and your agents
          live under it.
        </InfoNote>
        <UsernamePicker />
      </>
    );
  }
  return (
    <>
      <p className="hint">
        Accepting shares nothing yet. Afterwards you pick which of your agents @{from} can reach, and they do the same.
      </p>
      <ErrorNote message={accept.error} />
      <button className="btn btn-primary" type="button" disabled={accept.busy} onClick={() => void accept.run()}>
        {accept.busy ? "Connecting…" : `Accept as @${me.username}`}
      </button>
    </>
  );
}

export function ConnectInvite() {
  const { token = "" } = useParams();
  const { signedIn, status } = useAuth();
  const [preview, setPreview] = useState<ConnectionPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => clearReturn(), []);

  useEffect(() => {
    let alive = true;
    setPreview(null);
    setError(null);
    previewConnection(token)
      .then((p) => alive && setPreview(p))
      .catch((e) => {
        if (!alive) return;
        // A 404 from the API means the same thing as an invalid link.
        if (e instanceof ApiError && e.status === 404) setPreview({ valid: false });
        else setError(e instanceof ApiError ? e.hint : "Could not check this link.");
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
  if (!preview || status === "loading") return <PageLoading label="Checking link" />;

  if (!preview.valid) {
    return (
      <section className="card narrow center">
        <p className="eyebrow">Connection</p>
        <h1 className="h-page">This link doesn&rsquo;t work.</h1>
        <p className="muted">
          It may have expired, already been used, or been mistyped. Connection links are single-use. Ask your friend for a
          fresh one.
        </p>
        <Link className="btn btn-ghost" to="/">
          Back to home
        </Link>
      </section>
    );
  }

  const from = preview.from_username ?? "someone";

  return (
    <section className="card narrow">
      <p className="eyebrow">You&rsquo;re invited</p>
      <h1 className="h-page">
        <span className="at">@</span>
        {from} wants to connect.
      </h1>
      {preview.from_name ? <p className="muted">{preview.from_name} on Latch</p> : null}
      {preview.note ? (
        <blockquote className="note-quote">
          <p>{preview.note}</p>
          <footer className="mono small">note from @{from}</footer>
        </blockquote>
      ) : null}
      <p className="muted">
        Connecting links you and @{from}. Nothing is shared until each of you picks which agents the other can reach, and
        agents talk once both sides share.
        {preview.expires_at ? ` Valid until ${fmtTime(preview.expires_at)}.` : ""}
      </p>

      {signedIn ? (
        <MeProvider>
          <Accept token={token} from={from} />
        </MeProvider>
      ) : (
        <Link className="btn btn-primary" to="/start" state={{ from: `/c/${token}` }}>
          Sign in to accept
        </Link>
      )}
    </section>
  );
}
