import { useState, type FormEvent } from "react";
import { checkUsername, setUsername, type UsernameResult } from "../api";
import { useAction } from "../hooks";
import { renamePreview, usernameProblem } from "../lib";
import { useMe } from "../me";
import { NameInput, useAvailability } from "./NameField";
import { ErrorNote, InfoNote, Modal } from "./ui";

function Renames({ items }: { items: { from: string; to: string }[] }) {
  return (
    <ul className="renames">
      {items.map((r) => (
        <li key={r.from} className="mono">
          <span className="at">@</span>
          {r.from} <span aria-label="becomes">&rarr;</span> <span className="at">@</span>
          {r.to}
        </li>
      ))}
    </ul>
  );
}

/** Pick-once username form with an availability check and an "it's permanent" confirmation. */
export function UsernamePicker({ onDone, submitLabel = "Choose username" }: { onDone?: (r: UsernameResult) => void; submitLabel?: string }) {
  const { me, refresh } = useMe();
  const [name, setName] = useState("");
  const [confirm, setConfirm] = useState(false);
  const check = useAvailability(name, usernameProblem, checkUsername);
  const legacy = (me?.agents ?? []).map((a) => a.handle);
  const preview = name && !usernameProblem(name) ? renamePreview(name, legacy) : [];

  const claim = useAction(async () => {
    const result = await setUsername(name);
    setConfirm(false);
    onDone?.(result);
    await refresh(true);
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (check.state === "available") setConfirm(true);
  }

  return (
    <form className="form" onSubmit={onSubmit}>
      <NameInput
        label="Username"
        value={name}
        onChange={setName}
        check={check}
        prefix="@"
        placeholder="nebula"
        idleHint="3–32 characters: a–z, 0–9, single hyphens inside."
        availableText={`@${name} is available.`}
      />
      {legacy.length > 0 ? (
        <div className="hint">
          {preview.length > 0 ? (
            <>
              Your existing agents move under it:
              <Renames items={preview} />
            </>
          ) : (
            <>Your existing agents ({legacy.map((h) => `@${h}`).join(", ")}) move under it. Type a username to preview.</>
          )}
          Their old handles keep working, so tokens, scripts and friends&rsquo; pins don&rsquo;t break.
        </div>
      ) : null}
      <InfoNote tone="warn">You pick this once. It can&rsquo;t be changed later, so choose one you&rsquo;ll want for good.</InfoNote>
      <ErrorNote message={confirm ? null : claim.error} />
      <button className="btn btn-primary" type="submit" disabled={check.state !== "available"}>
        {submitLabel}
      </button>

      <Modal open={confirm} title={`Claim @${name} for good?`} onClose={() => setConfirm(false)} tone="danger">
        <p>
          <strong>@{name}</strong> becomes your username and the front of every agent you create, like{" "}
          <strong>@{name}.capy</strong>. You can&rsquo;t change it afterwards.
        </p>
        {preview.length > 0 ? (
          <>
            <p>These agents move under it:</p>
            <Renames items={preview} />
          </>
        ) : null}
        <ErrorNote message={claim.error} />
        <div className="actions">
          <button className="btn btn-primary" type="button" disabled={claim.busy} onClick={() => void claim.run()}>
            {claim.busy ? "Claiming…" : `Claim @${name}`}
          </button>
          <button className="btn btn-ghost" type="button" onClick={() => setConfirm(false)}>
            Cancel
          </button>
        </div>
      </Modal>
    </form>
  );
}

/**
 * Dashboard/People card that asks for a username while there is none. Stays up after
 * success to show which agents were renamed, until dismissed.
 */
export function UsernameCard() {
  const { me } = useMe();
  const [done, setDone] = useState<UsernameResult | null>(null);
  if (done) {
    return (
      <section className="card username-card" aria-labelledby="username-h">
        <h2 id="username-h">
          <span className="at">@</span>
          {done.username} is yours.
        </h2>
        <div aria-live="polite">
          {done.renamed.length > 0 ? (
            <>
              <InfoNote tone="ok">
                Your existing agents moved under it. The old handles still work as aliases.
              </InfoNote>
              <Renames items={done.renamed} />
            </>
          ) : (
            <InfoNote tone="ok">New agents you reserve will be @{done.username}.name.</InfoNote>
          )}
        </div>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setDone(null)}>
          Dismiss
        </button>
      </section>
    );
  }
  if (!me || me.username) return null;
  return (
    <section className="card username-card" aria-labelledby="username-h">
      <p className="eyebrow">One-time step</p>
      <h2 id="username-h">Pick your username.</h2>
      <p className="muted">
        Your agents live under it, like <code>@you.capy</code>. Only you can create agents under your name, and your own
        agents are linked to each other automatically.
      </p>
      <UsernamePicker onDone={setDone} />
    </section>
  );
}
