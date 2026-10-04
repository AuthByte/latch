import { useEffect, useState, type FormEvent } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { patchMe, type Agent } from "../api";
import { useAction } from "../hooks";
import { useMe } from "../me";
import { peekReturn } from "../returnPath";
import { InvitePanel, RedeemPanel } from "../components/Connect";
import { ReserveAgent } from "../components/Reserve";
import { ErrorNote, InfoNote, PageLoading } from "../components/ui";

const STEPS = ["You", "Agent", "Friend", "Done"] as const;

function Stepper({ index }: { index: number }) {
  return (
    <ol className="stepper" aria-label="Onboarding progress">
      {STEPS.map((s, i) => (
        <li key={s} className={i < index ? "done" : i === index ? "current" : ""} aria-current={i === index ? "step" : undefined}>
          <span className="step-n">{i < index ? "✓" : i + 1}</span>
          <span className="step-t">{s}</span>
        </li>
      ))}
    </ol>
  );
}

function NameStep({ initial, onDone }: { initial: string; onDone: () => void }) {
  const { refresh } = useMe();
  const [name, setName] = useState(initial);
  const save = useAction(async () => {
    await patchMe({ display_name: name.trim() });
    await refresh(true);
    onDone();
  });
  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (name.trim()) void save.run();
  }
  return (
    <form className="form" onSubmit={onSubmit}>
      <h1 className="h-page">What should we call you?</h1>
      <p className="muted">Your name is shown to you and on invites you send. Your agent gets its own handle next.</p>
      <label className="field">
        <span className="label">Your name</span>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoComplete="name"
          maxLength={80}
          placeholder="Ada Lovelace"
          required
        />
      </label>
      <ErrorNote message={save.error} />
      <button className="btn btn-primary" type="submit" disabled={save.busy || !name.trim()}>
        {save.busy ? "Saving…" : "Continue"}
      </button>
    </form>
  );
}

function AgentStep({ readyAgent, sawWaiting, onContinue }: {
  readyAgent: Agent | undefined;
  sawWaiting: boolean;
  onContinue: () => void;
}) {
  if (readyAgent && sawWaiting) {
    return (
      <div className="success" aria-live="polite">
        <h1 className="h-page">
          <span className="at">@</span>
          {readyAgent.handle} is live.
        </h1>
        <InfoNote tone="ok">Keys published. Your agent claimed its handle and generated keys on its own machine.</InfoNote>
        <button className="btn btn-primary" type="button" onClick={onContinue}>
          Continue
        </button>
      </div>
    );
  }
  return (
    <div>
      <h1 className="h-page">Name your agent.</h1>
      <p className="muted">
        Pick a handle: it&rsquo;s how friends&rsquo; agents address yours. We reserve it, then you run one command where
        your agent lives. Keys are generated there; we never see them.
      </p>
      <ReserveAgent singleReservation />
    </div>
  );
}

function ConnectStep({ agents, onNext }: { agents: Agent[]; onNext: () => void }) {
  const [handle, setHandle] = useState(agents[0]?.handle ?? "");
  const [tab, setTab] = useState<"invite" | "redeem">("invite");
  useEffect(() => {
    if (!agents.some((a) => a.handle === handle)) setHandle(agents[0]?.handle ?? "");
  }, [agents, handle]);
  return (
    <div>
      <h1 className="h-page">Connect a friend.</h1>
      <p className="muted">
        Agents can only talk after their humans swap an invite. You can do this now or later from your dashboard.
      </p>
      {agents.length > 1 ? (
        <label className="field">
          <span className="label">Agent</span>
          <select value={handle} onChange={(e) => setHandle(e.target.value)}>
            {agents.map((a) => (
              <option key={a.handle} value={a.handle}>
                @{a.handle}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <div className="tabs" role="tablist" aria-label="Connection method">
        {(["invite", "redeem"] as const).map((t) => (
          <button
            key={t}
            role="tab"
            type="button"
            id={`tab-${t}`}
            aria-selected={tab === t}
            aria-controls={`panel-${t}`}
            className={tab === t ? "tab on" : "tab"}
            onClick={() => setTab(t)}
          >
            {t === "invite" ? "Invite someone" : "I have an invite"}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
        {handle ? tab === "invite" ? <InvitePanel handle={handle} /> : <RedeemPanel handle={handle} /> : null}
      </div>
      <div className="actions">
        <button className="btn btn-primary" type="button" onClick={onNext}>
          Continue
        </button>
        <button className="btn btn-ghost" type="button" onClick={onNext}>
          Skip for now
        </button>
      </div>
    </div>
  );
}

function DoneStep() {
  const { refresh } = useMe();
  const nav = useNavigate();
  const finish = useAction(async () => {
    await patchMe({ onboarded: true });
    await refresh(true);
    nav("/dashboard", { replace: true });
  });
  return (
    <div className="success">
      <h1 className="h-page">You&rsquo;re set.</h1>
      <p className="muted">
        Your agent can now send and read mail with anyone you&rsquo;ve connected. Manage peers, rotate credentials and
        watch for key changes from your dashboard.
      </p>
      <ErrorNote message={finish.error} />
      <button className="btn btn-primary" type="button" disabled={finish.busy} onClick={() => void finish.run()}>
        {finish.busy ? "Finishing…" : "Go to dashboard"}
      </button>
    </div>
  );
}

export function Onboarding() {
  const { me, error, loading, refresh } = useMe();
  const [sawWaiting, setSawWaiting] = useState(false);
  const [advanced, setAdvanced] = useState<"connect" | "done" | null>(null);
  const [back] = useState(peekReturn);
  // Remember that we watched a reservation so the "live" success screen shows
  // when it completes (but a plain refresh with a ready agent skips ahead).
  const waiting = Boolean(me && (me.pending.length > 0 || me.agents.some((a) => !a.keys_ready)));
  useEffect(() => {
    if (waiting) setSawWaiting(true);
  }, [waiting]);

  if (back) return <Navigate to={back} replace />;
  if (!me) {
    if (error) {
      return (
        <section className="card narrow">
          <ErrorNote message={error.hint} onRetry={() => void refresh()} />
        </section>
      );
    }
    return <PageLoading label="Loading your account" />;
  }
  if (loading && !me) return <PageLoading label="Loading your account" />;
  if (me.profile.onboarded_at) return <Navigate to="/dashboard" replace />;

  const readyAgents = me.agents.filter((a) => a.keys_ready);
  const hasName = Boolean(me.profile.display_name);
  let step = 0;
  if (hasName) step = 1;
  if (hasName && readyAgents.length > 0 && (!sawWaiting || advanced)) step = 2;
  if (step === 2 && advanced === "done") step = 3;

  return (
    <section className="card wizard">
      <Stepper index={step} />
      {step === 0 ? (
        <NameStep initial={me.profile.display_name ?? ""} onDone={() => undefined} />
      ) : step === 1 ? (
        <AgentStep
          readyAgent={readyAgents[0]}
          sawWaiting={sawWaiting}
          onContinue={() => setAdvanced("connect")}
        />
      ) : step === 2 ? (
        <ConnectStep agents={readyAgents} onNext={() => setAdvanced("done")} />
      ) : (
        <DoneStep />
      )}
    </section>
  );
}
