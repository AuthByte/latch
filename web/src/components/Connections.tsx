import { useId, useState, type FormEvent } from "react";
import {
  acceptConnection,
  connectionTokenFrom,
  createConnectionInvite,
  deleteConnection,
  setShare,
  type Agent,
  type Connection,
  type InviteMint,
} from "../api";
import { useAction } from "../hooks";
import { fmtDate, fmtTime } from "../lib";
import { useMe } from "../me";
import { Badge, CopyField, ErrorNote, InfoNote, Modal } from "./ui";

/** Mint a single-use connection link (`/c/lci_…`) to send to a friend. */
export function CreateLink() {
  const { refresh } = useMe();
  const [note, setNote] = useState("");
  const [invite, setInvite] = useState<InviteMint | null>(null);
  const create = useAction(async () => {
    setInvite(await createConnectionInvite(note.trim() || undefined));
    setNote("");
    void refresh(true);
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    void create.run();
  }

  return (
    <section className="card" aria-labelledby="create-link-h">
      <h2 id="create-link-h">Connect a friend</h2>
      <p className="muted">
        A connection link joins you and one friend. It shares nothing by itself: afterwards each of you picks which
        agents to share.
      </p>
      {invite ? (
        <>
          <CopyField label="Connection link" value={invite.url} />
          <InfoNote tone="warn">
            Send this to your friend over a channel you trust (a DM, in person). Anyone holding the link can use it once,
            until {fmtTime(invite.expires_at)}.
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
            {create.busy ? "Creating…" : "Create connection link"}
          </button>
        </form>
      )}
    </section>
  );
}

/** Paste a link from a friend to connect with them. */
export function AcceptLink() {
  const { refresh } = useMe();
  const [value, setValue] = useState("");
  const [done, setDone] = useState<Connection | null>(null);
  const parsed = connectionTokenFrom(value);
  const accept = useAction(async () => {
    setDone(await acceptConnection(value.trim()));
    setValue("");
    await refresh(true);
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (parsed) void accept.run();
  }

  return (
    <section className="card" aria-labelledby="accept-link-h">
      <h2 id="accept-link-h">Got a link?</h2>
      <p className="muted">Paste a connection link a friend sent you.</p>
      {done ? (
        <div aria-live="polite">
          <InfoNote tone="ok">
            Connected with <strong>@{done.peer.username ?? "your friend"}</strong>. Pick which of your agents to share
            below.
          </InfoNote>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setDone(null)}>
            Accept another
          </button>
        </div>
      ) : (
        <form className="form" onSubmit={onSubmit}>
          <label className="field">
            <span className="label">Connection link</span>
            <input
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="https://…/c/lci_…"
              autoComplete="off"
              spellCheck={false}
              aria-invalid={value.trim() !== "" && !parsed}
            />
          </label>
          {value.trim() !== "" && !parsed ? <p className="hint bad">That doesn&rsquo;t look like a connection link.</p> : null}
          <ErrorNote message={accept.error} />
          <button className="btn btn-primary" type="submit" disabled={accept.busy || !parsed}>
            {accept.busy ? "Connecting…" : "Accept link"}
          </button>
        </form>
      )}
    </section>
  );
}

function ShareToggle({ conn, agent }: { conn: Connection; agent: Agent }) {
  const { refresh } = useMe();
  const shared = conn.mine.includes(agent.handle);
  // Stay busy through the refresh so the box never flickers back to the old state.
  const toggle = useAction(async (next: boolean) => {
    await setShare(conn.id, agent.handle, next);
    await refresh(true);
  });
  return (
    <li>
      <label className="check share">
        <input
          type="checkbox"
          checked={shared}
          disabled={toggle.busy}
          onChange={(e) => void toggle.run(e.target.checked)}
        />
        <span>
          <span className="at">@</span>
          {agent.handle}
          {agent.keys_ready ? null : <span className="muted small"> &middot; waiting for keys</span>}
        </span>
      </label>
      <ErrorNote message={toggle.error} />
    </li>
  );
}

function DeleteConnection({ conn, onClose }: { conn: Connection; onClose: () => void }) {
  const { refresh } = useMe();
  const peer = conn.peer.username ?? "this person";
  const del = useAction(async () => {
    await deleteConnection(conn.id);
    onClose();
    await refresh(true);
  });
  return (
    <>
      <p>
        This disconnects you from <strong>@{peer}</strong> and revokes every grant that came from it, in both
        directions. Their agents and yours can&rsquo;t message each other until you connect again.
      </p>
      <ErrorNote message={del.error} />
      <div className="actions">
        <button className="btn btn-danger" type="button" disabled={del.busy} onClick={() => void del.run()}>
          {del.busy ? "Removing…" : "Remove connection"}
        </button>
        <button className="btn btn-ghost" type="button" onClick={onClose}>
          Cancel
        </button>
      </div>
    </>
  );
}

function status(conn: Connection): { tone: "ok" | "warn" | "idle"; text: string } {
  const peer = `@${conn.peer.username ?? "them"}`;
  if (conn.mine.length > 0 && conn.theirs.length > 0) return { tone: "ok", text: "Agents can talk" };
  if (conn.mine.length > 0) return { tone: "warn", text: `Waiting for ${peer} to share` };
  if (conn.theirs.length > 0) return { tone: "warn", text: "Share one of yours to start" };
  return { tone: "idle", text: "Nothing shared yet" };
}

/** One person you're connected to: which of your agents you share, which of theirs you can reach. */
export function ConnectionCard({ conn }: { conn: Connection }) {
  const { me } = useMe();
  const [removing, setRemoving] = useState(false);
  const headId = useId();
  const mineId = useId();
  const theirsId = useId();
  const agents = me?.agents ?? [];
  const peer = conn.peer.username;
  const st = status(conn);

  return (
    <article className="agent" aria-labelledby={headId}>
      <header className="agent-head">
        <h2 id={headId}>
          {peer ? (
            <>
              <span className="at">@</span>
              {peer}
            </>
          ) : (
            "Someone without a username"
          )}
        </h2>
        <div className="badges">
          <Badge tone={st.tone}>{st.text}</Badge>
        </div>
      </header>
      <p className="muted small">Connected {fmtDate(conn.created_at)}</p>

      <div className="share-cols">
        <section aria-labelledby={mineId}>
          <h3 id={mineId} className="sub">
            Your agents
          </h3>
          {agents.length === 0 ? (
            <p className="muted">You have no agents yet. Reserve one on your dashboard, then share it here.</p>
          ) : (
            <>
              <p className="hint">Tick the agents {peer ? `@${peer}` : "they"} can reach.</p>
              <ul className="shares">
                {agents.map((a) => (
                  <ShareToggle key={a.handle} conn={conn} agent={a} />
                ))}
              </ul>
            </>
          )}
        </section>
        <section aria-labelledby={theirsId}>
          <h3 id={theirsId} className="sub">
            Their agents
          </h3>
          {conn.theirs.length === 0 ? (
            <p className="muted">They haven&rsquo;t shared any agents with you yet.</p>
          ) : (
            <ul className="shares">
              {conn.theirs.map((h) => (
                <li key={h} className="mono">
                  <span className="at">@</span>
                  {h}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <div className="actions agent-actions">
        <span className="spacer" />
        <button className="btn btn-ghost btn-sm danger-text" type="button" onClick={() => setRemoving(true)}>
          Remove connection
        </button>
      </div>

      <Modal open={removing} title={`Remove ${peer ? `@${peer}` : "this connection"}?`} onClose={() => setRemoving(false)} tone="danger">
        <DeleteConnection conn={conn} onClose={() => setRemoving(false)} />
      </Modal>
    </article>
  );
}
