import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import {
  ApiError,
  cancelSetupCode,
  checkHandle,
  createSetupCode,
  errorMessage,
  type Availability,
  type Pending,
  type SetupCode,
} from "../api";
import { useAction, useDebounced, useNow, usePoll } from "../hooks";
import { countdown, handleProblem, mcpFallback } from "../lib";
import { useMe } from "../me";
import { CopyField, ErrorNote, InfoNote, Spinner } from "./ui";

type Check =
  | { state: "idle" }
  | { state: "invalid"; message: string }
  | { state: "checking" }
  | { state: "available" }
  | { state: "unavailable"; message: string }
  | { state: "error"; message: string };

const REASONS: Record<NonNullable<Availability["reason"]>, string> = {
  invalid: "That isn't a valid handle.",
  taken: "Already taken. Try another.",
  reserved: "Reserved. Try another.",
};

function useHandleCheck(handle: string): Check {
  const debounced = useDebounced(handle, 350);
  const [result, setResult] = useState<Check>({ state: "idle" });
  const problem = handle ? handleProblem(handle) : null;

  useEffect(() => {
    if (!debounced) {
      setResult({ state: "idle" });
      return;
    }
    if (handleProblem(debounced)) return;
    const ctl = new AbortController();
    setResult({ state: "checking" });
    checkHandle(debounced, ctl.signal)
      .then((a) => {
        setResult(
          a.available
            ? { state: "available" }
            : { state: "unavailable", message: REASONS[a.reason ?? "taken"] },
        );
      })
      .catch((e) => {
        if (e instanceof DOMException && e.name === "AbortError") return;
        setResult({ state: "error", message: errorMessage(e) });
      });
    return () => ctl.abort();
  }, [debounced]);

  if (!handle) return { state: "idle" };
  if (problem) return { state: "invalid", message: problem };
  // Typed past the debounce: don't show a stale verdict for a different string.
  if (debounced !== handle) return { state: "checking" };
  return result;
}

function HandleInput({ value, onChange, check }: { value: string; onChange: (v: string) => void; check: Check }) {
  const id = useId();
  const descId = `${id}-d`;
  const invalid = check.state === "invalid" || check.state === "unavailable";
  return (
    <div className="field">
      <label htmlFor={id} className="label">
        Agent handle
      </label>
      <div className={`handle-input ${invalid ? "is-invalid" : check.state === "available" ? "is-valid" : ""}`}>
        <span className="handle-at" aria-hidden="true">
          @
        </span>
        <input
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value.toLowerCase().replace(/\s+/g, ""))}
          autoComplete="off"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          maxLength={40}
          placeholder="nebula"
          aria-invalid={invalid}
          aria-describedby={descId}
        />
      </div>
      <p id={descId} className={`hint handle-status ${invalid ? "bad" : check.state === "available" ? "good" : ""}`} aria-live="polite">
        {check.state === "idle" && "3–32 characters: a–z, 0–9, single hyphens inside."}
        {check.state === "checking" && "Checking availability…"}
        {check.state === "available" && `@${value} is available.`}
        {(check.state === "invalid" || check.state === "unavailable" || check.state === "error") && check.message}
      </p>
    </div>
  );
}

export function PendingCard({
  pending,
  mcp,
  command,
  claimed,
  onCancelled,
  onNewCode,
}: {
  pending: Pending;
  mcp?: string;
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
          <CopyField
            label="2. Connect it to Claude (MCP), after claiming"
            value={mcp ?? mcpFallback(pending.handle)}
            hint={mcp ? undefined : "Standard MCP command; adjust the path if you installed Latch elsewhere."}
          />
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

/** Reserve a handle, show its claim commands, poll until keys are ready. */
export function ReserveAgent({ singleReservation = false, onReady, submitLabel = "Reserve handle" }: Props) {
  const { me, refresh } = useMe();
  const [handle, setHandle] = useState("");
  const check = useHandleCheck(handle);
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

  const reserve = useAction(async (h: string) => {
    try {
      const sc = await createSetupCode(h);
      watched.current.add(h);
      setFresh((f) => ({ ...f, [h]: sc }));
      setHandle("");
      await refresh(true);
    } catch (e) {
      if (e instanceof ApiError && e.code === "handle_taken") {
        throw new ApiError(e.status, e.code, e.hint || "That handle was just taken. Try another.");
      }
      throw e;
    }
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (check.state === "available") void reserve.run(handle);
  }

  const showForm = !(singleReservation && shown.length > 0);

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
          mcp={fresh[p.handle]?.mcp_command}
          command={fresh[p.handle]?.command}
          onNewCode={() => void reserve.run(p.handle)}
          claimed={agentHandles.has(p.handle)}
          onCancelled={() => {
            watched.current.delete(p.handle);
            void refresh(true);
          }}
        />
      ))}

      {showForm ? (
        <form className="form" onSubmit={onSubmit}>
          <HandleInput value={handle} onChange={setHandle} check={check} />
          <ErrorNote message={reserve.error} />
          <button className="btn btn-primary" type="submit" disabled={reserve.busy || check.state !== "available"}>
            {reserve.busy ? "Reserving…" : submitLabel}
          </button>
          <p className="hint">Reserving holds the handle for 30 minutes while you run the command.</p>
        </form>
      ) : null}
    </div>
  );
}
