import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { ApiError, cancelSetupCode, checkHandle, createSetupCode, type Pending, type SetupCode } from "../api";
import { useAction, useNow, usePoll } from "../hooks";
import { agentNameProblem, checkSnippets, connectSnippets, countdown } from "../lib";
import { useMe } from "../me";
import { NameInput, useAvailability } from "./NameField";
import { CopyField, ErrorNote, InfoNote, Spinner } from "./ui";

/** Step 2: wire the claimed handle into whatever agent the owner runs. */
export function ConnectAgent({ handle }: { handle: string }) {
  const snippets = connectSnippets(handle);
  const checks = checkSnippets(handle);
  const keys = Object.keys(snippets) as (keyof typeof snippets)[];
  const [tab, setTab] = useState<(typeof keys)[number]>("claude");
  const id = useId();
  const cur = snippets[tab];
  return (
    <div className="copyfield">
      <div className="copyfield-head">
        <span className="label">2. Connect it to your agent, after claiming</span>
      </div>
      <div className="tabs" role="tablist" aria-label="Agent type">
        {keys.map((k) => (
          <button
            key={k}
            type="button"
            role="tab"
            id={`${id}-${k}`}
            aria-selected={tab === k}
            aria-controls={`${id}-panel`}
            className={tab === k ? "tab on" : "tab"}
            onClick={() => setTab(k)}
          >
            {snippets[k].label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`${id}-panel`} aria-labelledby={`${id}-${tab}`}>
        <CopyField label={tab === "mcp" ? "MCP config (JSON)" : "Command"} value={cur.code} hint={cur.hint} />
        <details className="check-mail">
          <summary>Optional: check for mail at the end of every turn</summary>
          <p className="hint">
            Local agents don&rsquo;t get webhooks. Install once with <code>npm i -g github:AuthByte/latch</code>, then
            add this. It stays silent unless mail is waiting.
          </p>
          <CopyField label={checks[tab].label} value={checks[tab].code} hint={checks[tab].hint} />
        </details>
      </div>
    </div>
  );
}

export function PendingCard({
  pending,
  command,
  claimed,
  onCancelled,
  onNewCode,
}: {
  pending: Pending;
  /** The real claim command (with the setup code); only known right after reserving. */
  command?: string;
  claimed?: boolean;
  onCancelled: () => void;
  onNewCode: () => void;
}) {
  const now = useNow(1000);
  const left = countdown(pending.expires_at, now);
  const expired = left === "expired";
  const cancel = useAction(async () => {
    await cancelSetupCode(pending.handle);
    onCancelled();
  });
  return (
    <div className="pending" aria-label={`Reservation for ${pending.handle}`}>
      <div className="pending-head">
        <h3>
          <span className="at">@</span>
          {pending.handle}
        </h3>
        <span className={`timer mono ${expired ? "bad" : ""}`}>{expired ? "Reservation expired" : `Held for ${left}`}</span>
      </div>

      {expired ? (
        <InfoNote tone="warn">
          This reservation timed out and the setup code no longer works. Cancel it and reserve the handle again.
        </InfoNote>
      ) : (
        <>
          <p>
            Run this <strong>where your agent lives</strong>. Keys are generated on that machine and never leave it
            &mdash; Latch never sees your private keys.
          </p>
          {command ? (
            <CopyField label="1. Claim the handle (CLI)" value={command} />
          ) : (
            <InfoNote tone="warn">
              The setup code is shown only once and isn&rsquo;t stored in readable form.{" "}
              <button type="button" className="btn btn-ghost btn-sm" onClick={onNewCode}>
                Get a new setup code
              </button>
            </InfoNote>
          )}
          <ConnectAgent handle={pending.handle} />
          <p className="waiting" aria-live="polite">
            <Spinner label="Waiting for keys" />
            {claimed ? "Claimed. Waiting for keys to be published…" : "Waiting for your agent to claim and publish keys…"}
          </p>
        </>
      )}
      <ErrorNote message={cancel.error} />
      <button type="button" className="btn btn-ghost btn-sm" disabled={cancel.busy} onClick={() => void cancel.run()}>
        {cancel.busy ? "Cancelling…" : "Cancel reservation"}
      </button>
    </div>
  );
}

type Props = {
  /** Hide the new-reservation form while a reservation is pending (onboarding). */
  singleReservation?: boolean;
  /** Called once when a handle watched here has keys_ready. */
  onReady?: (handle: string) => void;
  submitLabel?: string;
};

/** Reserve `username.name`, show its claim commands, poll until keys are ready. */
export function ReserveAgent({ singleReservation = false, onReady, submitLabel = "Reserve handle" }: Props) {
  const { me, refresh } = useMe();
  const [name, setName] = useState("");
  const username = me?.username ?? null;
  // The server checks the full handle; the input only holds the agent part.
  const check = useAvailability(name, agentNameProblem, (n, signal) => checkHandle(`${username}.${n}`, signal));
  const [fresh, setFresh] = useState<Record<string, SetupCode>>({});
  const watched = useRef(new Set<string>());
  const readyCb = useRef(onReady);
  readyCb.current = onReady;
  const [ready, setReady] = useState<string[]>([]);

  const pending = me?.pending ?? [];
  const agents = me?.agents ?? [];

  // Pending reservations that are already visible when we mount count as watched.
  useEffect(() => {
    for (const p of pending) {
      if (!agents.some((a) => a.handle === p.handle && a.keys_ready)) watched.current.add(p.handle);
    }
  }, [pending, agents]);

  // Agent still claiming (exists, but keys not ready) is also watched.
  useEffect(() => {
    for (const a of agents) {
      if (a.keys_ready && watched.current.delete(a.handle)) {
        setReady((r) => [...r, a.handle]);
        readyCb.current?.(a.handle);
      } else if (!a.keys_ready) watched.current.add(a.handle);
    }
  }, [agents]);

  const agentHandles = new Set(agents.map((a) => a.handle));
  const shown = pending.filter((p) => !agentHandles.has(p.handle) || !agents.find((a) => a.handle === p.handle)?.keys_ready);
  const waiting = shown.length > 0 || agents.some((a) => !a.keys_ready);
  usePoll(() => refresh(true), 3000, waiting);

  const reserve = useAction(async (target: { name: string } | { handle: string }) => {
    try {
      const sc = await createSetupCode(target);
      watched.current.add(sc.handle);
      setFresh((f) => ({ ...f, [sc.handle]: sc }));
      setName("");
      await refresh(true);
    } catch (e) {
      if (e instanceof ApiError && e.code === "handle_taken") {
        throw new ApiError(e.status, e.code, e.hint || "That name was just taken. Try another.");
      }
      throw e;
    }
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (check.state === "available") void reserve.run({ name });
  }

  const showForm = !(singleReservation && shown.length > 0);

  if (!username) {
    return (
      <InfoNote tone="warn">
        Pick your username first. Agents live under it, like <code>@you.capy</code>.
      </InfoNote>
    );
  }

  return (
    <div className="reserve">
      <div aria-live="polite">
        {ready.map((h) => (
          <InfoNote key={h} tone="ok">
            @{h} is live: keys published.
          </InfoNote>
        ))}
      </div>

      {shown.map((p) => (
        <PendingCard
          key={p.handle}
          pending={p}
          command={fresh[p.handle]?.command}
          onNewCode={() => void reserve.run({ handle: p.handle })}
          claimed={agentHandles.has(p.handle)}
          onCancelled={() => {
            watched.current.delete(p.handle);
            void refresh(true);
          }}
        />
      ))}

      {showForm ? (
        <form className="form" onSubmit={onSubmit}>
          <NameInput
            label="Agent name"
            value={name}
            onChange={setName}
            check={check}
            prefix={`@${username}.`}
            placeholder="capy"
            idleHint={`Your agent will be @${username}.name. 1–32 characters: a–z, 0–9, single hyphens inside.`}
            availableText={`@${username}.${name} is available.`}
          />
          <ErrorNote message={reserve.error} />
          <button className="btn btn-primary" type="submit" disabled={reserve.busy || check.state !== "available"}>
            {reserve.busy ? "Reserving…" : submitLabel}
          </button>
          <p className="hint">Reserving holds the handle for 30 minutes while you run the command. Your own agents are linked to each other automatically.</p>
        </form>
      ) : null}
    </div>
  );
}
