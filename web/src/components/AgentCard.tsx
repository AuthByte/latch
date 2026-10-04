import { useState } from "react";
import {
  deleteAgent,
  repinGrant,
  resetAgent,
  revokeGrant,
  type Agent,
  type Fingerprints,
  type Peer,
  type ResetResult,
} from "../api";
import { useAction } from "../hooks";
import { fmtDate, fmtTime } from "../lib";
import { useMe } from "../me";
import { InvitePanel, RedeemPanel } from "./Connect";
import { Badge, CopyField, ErrorNote, Fingerprint, FingerprintPair, InfoNote, Modal } from "./ui";

// ---------- peers ----------

function FingerprintCompare({ pinned, current }: { pinned: Fingerprints; current: Fingerprints }) {
  const signingChanged = pinned.signing !== current.signing;
  const ageChanged = pinned.age !== current.age;
  return (
    <div className="fp-compare">
      <div className="fp-col">
        <h4>Pinned (what you trusted)</h4>
        <Fingerprint label="signing" value={pinned.signing} tone="pinned" />
        <Fingerprint label="age" value={pinned.age} tone="pinned" />
      </div>
      <div className="fp-col">
        <h4>Current (what they publish now)</h4>
        <Fingerprint label="signing" value={current.signing} tone={signingChanged ? "bad" : "current"} />
        <Fingerprint label="age" value={current.age} tone={ageChanged ? "bad" : "current"} />
      </div>
    </div>
  );
}

function PeerRow({ agent, peer }: { agent: Agent; peer: Peer }) {
  const { refresh } = useMe();
  const [dialog, setDialog] = useState<null | "repin" | "revoke">(null);
  const [verified, setVerified] = useState(false);
  const close = () => {
    setDialog(null);
    setVerified(false);
  };
  const repin = useAction(async () => {
    await repinGrant(agent.handle, peer.grant_id);
    close();
    await refresh(true);
  });
  const revoke = useAction(async () => {
    await revokeGrant(agent.handle, peer.grant_id);
    close();
    await refresh(true);
  });

  const tone = peer.status === "active" ? "ok" : peer.status === "key_changed" ? "bad" : "warn";
  const label =
    peer.status === "active" ? "Active" : peer.status === "key_changed" ? "Key changed" : "Awaiting peer repin";

  return (
    <li className={`peer peer-${peer.status}`}>
      <div className="peer-head">
        <div>
          <strong className="peer-handle">
            <span className="at">@</span>
            {peer.handle}
          </strong>
          <span className="muted small"> &middot; connected {fmtDate(peer.created_at)}</span>
        </div>
        <Badge tone={tone}>{label}</Badge>
      </div>

      {peer.status === "key_changed" ? (
        <div className="alert" role="alert">
          <p>
            <strong>@{peer.handle}&rsquo;s keys changed.</strong> Mail with them is halted in both directions until you
            decide. Verify with your friend out-of-band (call them, or ask in person) that the current fingerprints
            below are theirs before accepting.
          </p>
          <FingerprintCompare pinned={peer.pinned} current={peer.current} />
          <div className="actions">
            <button className="btn btn-danger btn-sm" type="button" onClick={() => setDialog("repin")}>
              Repin to new keys…
            </button>
            <button className="btn btn-ghost btn-sm" type="button" onClick={() => setDialog("revoke")}>
              Revoke instead…
            </button>
          </div>
        </div>
      ) : (
        <>
          {peer.status === "awaiting_peer_repin" ? (
            <p className="hint">
              You&rsquo;ve accepted their keys. Now @{peer.handle}&rsquo;s owner needs to repin yours before mail flows
              again.
            </p>
          ) : null}
          <details className="fp-details">
            <summary>Pinned fingerprints</summary>
            <FingerprintPair fp={peer.pinned} />
          </details>
          <div className="actions">
            <button className="btn btn-ghost btn-sm" type="button" onClick={() => setDialog("revoke")}>
              Revoke
            </button>
          </div>
        </>
      )}

      <Modal open={dialog === "repin"} title={`Accept @${peer.handle}'s new keys?`} onClose={close} tone="danger">
        <p>
          Repinning tells <strong>@{agent.handle}</strong> to trust the key shown as &ldquo;current&rdquo;. If that key
          isn&rsquo;t really your friend&rsquo;s, whoever holds it can read mail you send them.
        </p>
        <FingerprintCompare pinned={peer.pinned} current={peer.current} />
        <label className="check">
          <input type="checkbox" checked={verified} onChange={(e) => setVerified(e.target.checked)} />
          <span>I verified these fingerprints with @{peer.handle} out-of-band.</span>
        </label>
        <ErrorNote message={repin.error} />
        <div className="actions">
          <button className="btn btn-danger" type="button" disabled={!verified || repin.busy} onClick={() => void repin.run()}>
            {repin.busy ? "Repinning…" : "Repin"}
          </button>
          <button className="btn btn-ghost" type="button" onClick={close}>
            Cancel
          </button>
        </div>
      </Modal>

      <Modal open={dialog === "revoke"} title={`Revoke @${peer.handle}?`} onClose={close} tone="danger">
        <p>
          This ends the grant between <strong>@{agent.handle}</strong> and <strong>@{peer.handle}</strong>. Neither
          agent can message the other until you swap a fresh invite.
        </p>
        <ErrorNote message={revoke.error} />
        <div className="actions">
          <button className="btn btn-danger" type="button" disabled={revoke.busy} onClick={() => void revoke.run()}>
            {revoke.busy ? "Revoking…" : "Revoke peer"}
          </button>
          <button className="btn btn-ghost" type="button" onClick={close}>
            Cancel
          </button>
        </div>
      </Modal>
    </li>
  );
}

// ---------- agent-level dialogs ----------

function ResetDialog({ agent, onClose }: { agent: Agent; onClose: () => void }) {
  const [result, setResult] = useState<ResetResult | null>(null);
  const reset = useAction(async () => {
    setResult(await resetAgent(agent.handle));
  });
  return (
    <>
      {result ? (
        <>
          <InfoNote tone="warn">
            <strong>This is shown once.</strong> Copy it now. It can&rsquo;t be retrieved again, and anyone who has it
            can take over @{agent.handle} until it expires ({fmtTime(result.expires_at)}).
          </InfoNote>
          <CopyField label="Reset token" value={result.reset_token} />
          <CopyField label="Run where your agent lives" value={result.command} />
          <div className="actions">
            <button className="btn btn-primary" type="button" onClick={onClose}>
              I&rsquo;ve saved it
            </button>
          </div>
        </>
      ) : (
        <>
          <p>
            Use this if the agent lost its credentials. Reclaiming <strong>rotates its secrets and clears its
            webhook</strong>; the old credentials stop working. You get a one-time token and a command for the machine
            where the agent lives.
          </p>
          <ErrorNote message={reset.error} />
          <div className="actions">
            <button className="btn btn-danger" type="button" disabled={reset.busy} onClick={() => void reset.run()}>
              {reset.busy ? "Generating…" : "Generate reset token"}
            </button>
            <button className="btn btn-ghost" type="button" onClick={onClose}>
              Cancel
            </button>
          </div>
        </>
      )}
    </>
  );
}

function DeleteDialog({ agent, onClose }: { agent: Agent; onClose: () => void }) {
  const { refresh } = useMe();
  const [typed, setTyped] = useState("");
  const del = useAction(async () => {
    await deleteAgent(agent.handle);
    onClose();
    await refresh(true);
  });
  const ok = typed === agent.handle;
  return (
    <>
      <p>
        This permanently deletes <strong>@{agent.handle}</strong>, its handle and all {agent.peers.length} peer
        {agent.peers.length === 1 ? "" : "s"}. Unread mail is dropped. This can&rsquo;t be undone.
      </p>
      <label className="field">
        <span className="label">
          Type <code>{agent.handle}</code> to confirm
        </span>
        <input value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} />
      </label>
      <ErrorNote message={del.error} />
      <div className="actions">
        <button className="btn btn-danger" type="button" disabled={!ok || del.busy} onClick={() => void del.run()}>
          {del.busy ? "Deleting…" : "Delete agent"}
        </button>
        <button className="btn btn-ghost" type="button" onClick={onClose}>
          Cancel
        </button>
      </div>
    </>
  );
}

// ---------- card ----------

type Dialog = null | "invite" | "redeem" | "reset" | "delete";

export function AgentCard({ agent }: { agent: Agent }) {
  const [dialog, setDialog] = useState<Dialog>(null);
  const close = () => setDialog(null);
  const changed = agent.peers.filter((p) => p.status === "key_changed").length;
  const wh = agent.webhook;

  return (
    <article className="agent" aria-labelledby={`agent-${agent.handle}`}>
      <header className="agent-head">
        <h2 id={`agent-${agent.handle}`}>
          <span className="at">@</span>
          {agent.handle}
        </h2>
        <div className="badges">
          <Badge tone={agent.keys_ready ? "ok" : "warn"}>{agent.keys_ready ? "Keys ready" : "Waiting for keys"}</Badge>
          <Badge tone={wh.connected ? "ok" : "idle"}>{wh.connected ? "Webhook on" : "No webhook"}</Badge>
          <Badge tone={agent.unread > 0 ? "warn" : "idle"}>{agent.unread} unread</Badge>
          {changed > 0 ? <Badge tone="bad">{changed} key change{changed > 1 ? "s" : ""}</Badge> : null}
        </div>
      </header>

      <dl className="meta">
        <div>
          <dt>Fingerprints</dt>
          <dd>{agent.keys_ready ? <FingerprintPair fp={agent.fingerprints} /> : <span className="muted">Not published yet</span>}</dd>
        </div>
        <div>
          <dt>Webhook</dt>
          <dd className="mono small">
            {wh.connected ? `${wh.url ?? "connected"}${wh.auth_mode ? ` · ${wh.auth_mode}` : ""}` : "Not connected (agent polls)"}
          </dd>
        </div>
        <div>
          <dt>Created</dt>
          <dd className="small">{fmtDate(agent.created_at)}</dd>
        </div>
      </dl>

      <section aria-label={`Peers of ${agent.handle}`}>
        <h3 className="sub">Peers</h3>
        {agent.peers.length === 0 ? (
          <p className="muted">No peers yet. Create an invite and send it to a friend, or redeem one you received.</p>
        ) : (
          <ul className="peers">
            {agent.peers.map((p) => (
              <PeerRow key={p.grant_id} agent={agent} peer={p} />
            ))}
          </ul>
        )}
      </section>

      <div className="actions agent-actions">
        <button className="btn btn-primary btn-sm" type="button" disabled={!agent.keys_ready} onClick={() => setDialog("invite")}>
          Create invite
        </button>
        <button className="btn btn-ghost btn-sm" type="button" disabled={!agent.keys_ready} onClick={() => setDialog("redeem")}>
          Redeem invite
        </button>
        <span className="spacer" />
        <button className="btn btn-ghost btn-sm" type="button" onClick={() => setDialog("reset")}>
          Reset credentials
        </button>
        <button className="btn btn-ghost btn-sm danger-text" type="button" onClick={() => setDialog("delete")}>
          Delete
        </button>
      </div>

      <Modal open={dialog === "invite"} title={`Invite someone to @${agent.handle}`} onClose={close}>
        <InvitePanel handle={agent.handle} />
      </Modal>
      <Modal open={dialog === "redeem"} title={`Redeem an invite for @${agent.handle}`} onClose={close}>
        <RedeemPanel handle={agent.handle} />
      </Modal>
      <Modal open={dialog === "reset"} title={`Reset credentials for @${agent.handle}`} onClose={close} tone="danger">
        <ResetDialog agent={agent} onClose={close} />
      </Modal>
      <Modal open={dialog === "delete"} title={`Delete @${agent.handle}?`} onClose={close} tone="danger">
        <DeleteDialog agent={agent} onClose={close} />
      </Modal>
    </article>
  );
}
