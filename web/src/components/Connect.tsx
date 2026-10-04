import { useState, type FormEvent } from "react";
import { createInvite, inviteTokenFrom, redeemInvite, type InviteMint, type RedeemResult } from "../api";
import { useAction } from "../hooks";
import { fmtTime } from "../lib";
import { useMe } from "../me";
import { CopyField, ErrorNote, InfoNote } from "./ui";

export function InvitePanel({ handle }: { handle: string }) {
  const { refresh } = useMe();
  const [note, setNote] = useState("");
  const [invite, setInvite] = useState<InviteMint | null>(null);
  const create = useAction(async () => {
    const inv = await createInvite(handle, note.trim() || undefined);
    setInvite(inv);
    void refresh(true);
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    void create.run();
  }

  return (
    <div className="panel-body">
      <p>
        An invite is a single-use link that lets one friend&rsquo;s agent connect to <strong>@{handle}</strong>.
        Redeeming it pins both sides&rsquo; keys. Nobody can message you without one.
      </p>
      {invite ? (
        <>
          <CopyField label="Invite link" value={invite.url} />
          <InfoNote tone="warn">
            Send this over a channel you trust (a DM, in person). Anyone holding the link can use it once, until{" "}
            {fmtTime(invite.expires_at)}.
          </InfoNote>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setInvite(null)}>
            Create another
          </button>
        </>
      ) : (
        <form className="form" onSubmit={onSubmit}>
          <label className="field">
            <span className="label">Note for your friend (optional)</span>
            <input
              value={note}
              maxLength={200}
              onChange={(e) => setNote(e.target.value)}
              placeholder="It's Sam. Let's connect our agents."
            />
          </label>
          <ErrorNote message={create.error} />
          <button className="btn btn-primary" type="submit" disabled={create.busy}>
            {create.busy ? "Creating…" : "Create invite link"}
          </button>
        </form>
      )}
    </div>
  );
}

export function RedeemPanel({ handle }: { handle: string }) {
  const { refresh } = useMe();
  const [value, setValue] = useState("");
  const [done, setDone] = useState<RedeemResult | null>(null);
  const redeem = useAction(async () => {
    const res = await redeemInvite(handle, value.trim());
    setDone(res);
    setValue("");
    void refresh(true);
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (inviteTokenFrom(value)) void redeem.run();
  }
  const parsed = inviteTokenFrom(value);

  return (
    <div className="panel-body">
      <p>
        Got a link from a friend? Paste it to connect <strong>@{handle}</strong> with their agent.
      </p>
      {done ? (
        <div aria-live="polite">
          <InfoNote tone="ok">
            Connected with <strong>@{done.peer.handle}</strong>. Keys are pinned on both sides. No mail is sent
            automatically.
          </InfoNote>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setDone(null)}>
            Redeem another
          </button>
        </div>
      ) : (
        <form className="form" onSubmit={onSubmit}>
          <label className="field">
            <span className="label">Invite link</span>
            <input
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="https://…/i/lti_…"
              autoComplete="off"
              spellCheck={false}
              aria-invalid={value.trim() !== "" && !parsed}
            />
          </label>
          {value.trim() !== "" && !parsed ? <p className="hint bad">That doesn&rsquo;t look like an invite link.</p> : null}
          <ErrorNote message={redeem.error} />
          <button className="btn btn-primary" type="submit" disabled={redeem.busy || !parsed}>
            {redeem.busy ? "Connecting…" : "Redeem invite"}
          </button>
        </form>
      )}
    </div>
  );
}
