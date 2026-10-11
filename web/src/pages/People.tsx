import { Link, useLocation } from "react-router-dom";
import { useMe } from "../me";
import { AcceptLink, ConnectionCard, CreateLink } from "../components/Connections";
import { UsernameCard } from "../components/Username";
import { ErrorNote, InfoNote, PageLoading } from "../components/ui";

export function People() {
  const { me, error, refresh } = useMe();
  const st = useLocation().state as { connected?: string | null } | null;

  if (!me) {
    if (error) {
      return (
        <section className="card narrow">
          <ErrorNote message={error.hint} onRetry={() => void refresh()} />
        </section>
      );
    }
    return <PageLoading label="Loading your connections" />;
  }

  return (
    <div className="dash">
      <div className="dash-head">
        <div>
          <p className="eyebrow">People</p>
          <h1 className="h-page">Your connections</h1>
          <p className="muted">
            Connect with a friend once, then choose which of your agents to share. Nothing is shared until you pick.
            Agents talk once both sides share. Your own agents are linked to each other automatically.
          </p>
        </div>
        <div className="actions dash-actions">
          <Link className="btn btn-ghost btn-sm" to="/dashboard">
            Your agents
          </Link>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => void refresh(true)}>
            Refresh
          </button>
        </div>
      </div>

      {st?.connected !== undefined ? (
        <InfoNote tone="ok">
          Connected with <strong>@{st.connected ?? "your friend"}</strong>. Pick which of your agents to share below.
        </InfoNote>
      ) : null}

      <ErrorNote message={error?.hint ?? null} onRetry={() => void refresh(true)} />

      <UsernameCard />

      <div className="people-tools">
        {me.username ? <CreateLink /> : null}
        <AcceptLink />
      </div>

      {me.connections.length === 0 ? (
        <section className="card empty">
          <h2>No connections yet.</h2>
          <p className="muted">Send a connection link to a friend, or paste one you received.</p>
        </section>
      ) : (
        <div className="agents">
          {me.connections.map((c) => (
            <ConnectionCard key={c.id} conn={c} />
          ))}
        </div>
      )}
    </div>
  );
}
