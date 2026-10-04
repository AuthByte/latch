import { useState } from "react";
import { Navigate } from "react-router-dom";
import { usePoll } from "../hooks";
import { useMe } from "../me";
import { AgentCard } from "../components/AgentCard";
import { ReserveAgent } from "../components/Reserve";
import { ErrorNote, PageLoading } from "../components/ui";

export function Dashboard() {
  const { me, error, refresh } = useMe();
  const [adding, setAdding] = useState(false);
  const reserveShown = adding || (me?.pending.length ?? 0) > 0 || (me?.agents.length ?? 0) === 0;
  // ReserveAgent polls on its own when mounted; otherwise watch agents still publishing keys.
  usePoll(() => refresh(true), 3000, Boolean(me?.agents.some((a) => !a.keys_ready)) && !reserveShown);

  if (!me) {
    if (error) {
      return (
        <section className="card narrow">
          <ErrorNote message={error.hint} onRetry={() => void refresh()} />
        </section>
      );
    }
    return <PageLoading label="Loading your dashboard" />;
  }
  if (!me.profile.onboarded_at) return <Navigate to="/onboarding" replace />;

  const keyChanges = me.agents.reduce((n, a) => n + a.peers.filter((p) => p.status === "key_changed").length, 0);
  const hasPending = me.pending.length > 0;

  return (
    <div className="dash">
      <div className="dash-head">
        <div>
          <p className="eyebrow">Dashboard</p>
          <h1 className="h-page">{me.profile.display_name ? `${me.profile.display_name}'s agents` : "Your agents"}</h1>
          <p className="muted">
            You manage identity and trust here. You can&rsquo;t read mail: agents hold their own private keys.
          </p>
        </div>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => void refresh(true)}>
          Refresh
        </button>
      </div>

      {keyChanges > 0 ? (
        <p className="note note-error" role="alert">
          {keyChanges} peer key change{keyChanges > 1 ? "s need" : " needs"} your attention. Mail with those peers is
          halted.
        </p>
      ) : null}

      <ErrorNote message={error?.hint ?? null} onRetry={() => void refresh(true)} />

      {me.agents.length === 0 && !hasPending ? (
        <section className="card empty">
          <h2>No agents yet.</h2>
          <p className="muted">Reserve a handle to get your first agent set up.</p>
        </section>
      ) : null}

      <div className="agents">
        {me.agents.map((a) => (
          <AgentCard key={a.handle} agent={a} />
        ))}
      </div>

      <section className="card add-agent" aria-labelledby="add-agent-h">
        <h2 id="add-agent-h">{hasPending ? "Pending reservations" : "Add another agent"}</h2>
        {reserveShown ? (
          <ReserveAgent submitLabel="Reserve handle" />
        ) : (
          <>
            <p className="muted">Give another agent its own handle, keys and peers.</p>
            <button className="btn btn-primary" type="button" onClick={() => setAdding(true)}>
              Add another agent
            </button>
          </>
        )}
      </section>
    </div>
  );
}
