import {
  actorId,
  bearerToken,
  connectionId,
  connectionInviteToken,
  grantId,
  HANDLE_RE,
  inviteToken,
  recoverySecret,
  resetToken,
  splitHandle,
  USERNAME_RE,
} from "./ids.js";
import { sha256hex } from "./crypto.js";
import {
  INVITE_TTL_MS,
  RESET_TTL_MS,
  UNREAD_TTL_MS,
  type Envelope,
  type GrantView,
  type InboxHeader,
  type Intent,
  type Priority,
  type Receipt,
  isAgeArmored,
} from "./types.js";
import type { WebhookDest } from "./webhooks.js";
import {
  AGE_KEY_RE,
  computeGrantView,
  grantStatus,
  pinFor,
  SIGNING_KEY_RE,
  storeError,
  type Actor,
  type AgentPublic,
  type Connection,
  type ConnectionInvite,
  type ConnectionView,
  type Grant,
  type Invite,
  type Profile,
  type Reservation,
  type ResetTicket,
  type Retention,
  type Store,
  type StoredMessage,
} from "./store-types.js";

export type {
  Actor,
  AgentPublic,
  Connection,
  ConnectionInvite,
  ConnectionView,
  Grant,
  Invite,
  OpenResult,
  Pin,
  Profile,
  Reservation,
  ResetTicket,
  Retention,
  Store,
  StoredMessage,
} from "./store-types.js";

export type Clock = () => number;

export class MemoryStore {
  actors = new Map<string, Actor>();
  actorsByHandle = new Map<string, string>();
  actorsByTokenHash = new Map<string, string>();
  invites = new Map<string, Invite>();
  grants = new Map<string, Grant>();
  messages = new Map<string, StoredMessage>();
  /** from+id → message id */
  idempotency = new Map<string, string>();
  resetTickets = new Map<string, ResetTicket>();
  /** handle → reservation */
  reservations = new Map<string, Reservation>();
  /** owner id → profile */
  profiles = new Map<string, Profile>();
  /** old handle -> actor id (kept when an agent moves under its owner's username) */
  aliases = new Map<string, string>();
  connections = new Map<string, Connection>();
  connectionInvites = new Map<string, ConnectionInvite>();
  /** `${connectionId}:${actorId}` */
  shares = new Set<string>();

  constructor(public now: Clock = () => Date.now()) {}

  claim(
    handle: string,
    opts: { recovery?: string; setupCodeHash?: string } = {},
  ): { actor: Actor; token: string; recovery_secret: string } {
    const { recovery, setupCodeHash } = opts;
    if (!HANDLE_RE.test(handle)) throw storeError("invalid_handle");
    if (this.nameInUse(handle)) throw storeError("handle_taken");
    const r = this.liveReservation(handle);
    if (setupCodeHash !== undefined && (!r || r.codeHash !== setupCodeHash)) {
      throw storeError("bad_setup_code");
    }
    if (r && setupCodeHash === undefined) throw storeError("handle_reserved");
    // "nebula.capy" lives in nebula's namespace: only nebula's setup codes create it.
    if (!r && splitHandle(handle).owner) throw storeError("handle_reserved");
    const token = bearerToken();
    const recovery_secret =
      recovery && recovery.length >= 16 ? recovery : recoverySecret();
    const id = actorId(this.now());
    const actor: Actor = {
      actorId: id,
      handle,
      tokenHash: sha256hex(token),
      recoveryHash: sha256hex(recovery_secret),
      retention: { enabled: false, ttl_seconds: null },
      createdAt: this.now(),
    };
    if (r) {
      actor.ownerId = r.ownerId;
      this.reservations.delete(handle);
    }
    this.actors.set(id, actor);
    this.actorsByHandle.set(handle, id);
    this.actorsByTokenHash.set(actor.tokenHash, id);
    if (actor.ownerId) this.linkSiblings(actor.ownerId);
    return { actor, token, recovery_secret };
  }

  /** Is this exact string an actor handle, an alias, or someone's username? */
  private nameInUse(name: string): boolean {
    return this.actorsByHandle.has(name) || this.aliases.has(name) || this.usernameOwner(name) !== undefined;
  }

  private usernameOwner(name: string): string | undefined {
    for (const [owner, p] of this.profiles) if (p.username === name) return owner;
    return undefined;
  }

  private newGrant(x: Actor, y: Actor, connectionId?: string): Grant {
    const [a, b] = x.actorId < y.actorId ? [x, y] : [y, x];
    const grant: Grant = {
      id: grantId(this.now()),
      a: a.actorId,
      b: b.actorId,
      pinA: { age: a.agePublicKey, signing: a.signingPublicKey },
      pinB: { age: b.agePublicKey, signing: b.signingPublicKey },
      createdAt: this.now(),
      revoked: false,
      ...(connectionId ? { connectionId } : {}),
    };
    this.grants.set(this.pairKey(grant.a, grant.b), grant);
    return grant;
  }

  /** An owner's own agents can always reach each other. Pins fill on first publish. */
  private linkSiblings(ownerId: string): void {
    const mine = this.listOwnedActors(ownerId);
    for (let i = 0; i < mine.length; i++) {
      for (let j = i + 1; j < mine.length; j++) {
        if (!this.findGrant(mine[i].actorId, mine[j].actorId)) this.newGrant(mine[i], mine[j]);
      }
    }
  }

  recover(
    handle: string,
    secret: string,
  ): { actor: Actor; token: string } | null {
    const id = this.actorsByHandle.get(handle);
    if (!id) return null;
    const actor = this.actors.get(id);
    if (!actor) return null;
    if (sha256hex(secret) !== actor.recoveryHash) return null;
    this.actorsByTokenHash.delete(actor.tokenHash);
    const token = bearerToken();
    actor.tokenHash = sha256hex(token);
    this.actorsByTokenHash.set(actor.tokenHash, actor.actorId);
    return { actor, token };
  }

  byToken(token: string): Actor | undefined {
    const id = this.actorsByTokenHash.get(sha256hex(token));
    return id ? this.actors.get(id) : undefined;
  }

  byHandle(handle: string): Actor | undefined {
    const id = this.actorsByHandle.get(handle) ?? this.aliases.get(handle);
    return id ? this.actors.get(id) : undefined;
  }

  byId(id: string): Actor | undefined {
    return this.actors.get(id);
  }

  publishAge(actor: Actor, publicKey: string): void {
    if (!AGE_KEY_RE.test(publicKey)) throw storeError("invalid_age_key");
    actor.agePublicKey = publicKey;
    this.fillEmptyPins(actor, "age", publicKey);
  }

  publishSigning(actor: Actor, publicKey: string): void {
    if (!SIGNING_KEY_RE.test(publicKey)) throw storeError("invalid_signing_key");
    actor.signingPublicKey = publicKey;
    this.fillEmptyPins(actor, "signing", publicKey);
  }

  setRetention(actor: Actor, retention: Retention): void {
    actor.retention = retention;
  }

  /**
   * A grant redeemed before an actor published a key pinned nothing for that
   * slot. The first key published afterwards fills the empty pin (same trust as
   * redeem). A key that replaces an existing pin never does: that is a rotation
   * and flips the grant to key_changed.
   */
  private fillEmptyPins(actor: Actor, slot: "age" | "signing", key: string): void {
    for (const g of this.grants.values()) {
      if (g.revoked) continue;
      const pin = g.a === actor.actorId ? g.pinA : g.b === actor.actorId ? g.pinB : null;
      if (pin && pin[slot] === undefined) pin[slot] = key;
    }
  }

  createInvite(fromActorId: string, note?: string): Invite {
    const inv: Invite = {
      token: inviteToken(),
      fromActorId,
      note,
      expiresAt: this.now() + INVITE_TTL_MS,
      redeemed: false,
    };
    this.invites.set(inv.token, inv);
    return inv;
  }

  getInvite(token: string): Invite | undefined {
    return this.invites.get(token);
  }

  pairKey(a: string, b: string): string {
    return a < b ? `${a}:${b}` : `${b}:${a}`;
  }

  findGrant(a: string, b: string): Grant | undefined {
    const g = this.grants.get(this.pairKey(a, b));
    if (!g || g.revoked) return undefined;
    return g;
  }

  redeem(token: string, redeemer: Actor): Grant {
    const inv = this.invites.get(token);
    if (!inv) {
      throw Object.assign(new Error("unknown_invite"), { code: "unknown_invite" });
    }
    if (inv.redeemed) {
      throw Object.assign(new Error("invite_spent"), { code: "invite_spent" });
    }
    if (inv.expiresAt <= this.now()) {
      throw Object.assign(new Error("invite_expired"), { code: "invite_expired" });
    }
    if (inv.fromActorId === redeemer.actorId) {
      throw Object.assign(new Error("self_redeem"), { code: "self_redeem" });
    }
    const issuer = this.actors.get(inv.fromActorId);
    if (!issuer) {
      throw Object.assign(new Error("unknown_invite"), { code: "unknown_invite" });
    }
    if (this.findGrant(issuer.actorId, redeemer.actorId)) {
      throw Object.assign(new Error("already_granted"), { code: "already_granted" });
    }
    inv.redeemed = true;
    return this.newGrant(issuer, redeemer);
  }

  grantStatus(grant: Grant, viewerId: string): GrantView["status"] {
    const peerId = grant.a === viewerId ? grant.b : grant.a;
    return grantStatus(grant, viewerId, this.actors.get(viewerId), this.actors.get(peerId));
  }

  /** The key the peer pinned for `actorId` — what their signatures must verify against. */
  pinnedFor(grant: Grant, actorId: string): { age?: string; signing?: string } {
    return pinFor(grant, actorId);
  }

  grantView(grant: Grant, viewerId: string): GrantView {
    const peerId = grant.a === viewerId ? grant.b : grant.a;
    return computeGrantView(grant, viewerId, this.actors.get(viewerId), this.actors.get(peerId));
  }

  listGrants(viewerId: string): GrantView[] {
    const out: GrantView[] = [];
    for (const g of this.grants.values()) {
      if (g.revoked) continue;
      if (g.a !== viewerId && g.b !== viewerId) continue;
      out.push(this.grantView(g, viewerId));
    }
    return out.sort((x, y) => x.created_at.localeCompare(y.created_at));
  }

  grantById(id: string, viewerId: string): Grant | undefined {
    for (const g of this.grants.values()) {
      if (g.id === id && !g.revoked && (g.a === viewerId || g.b === viewerId)) {
        return g;
      }
    }
    return undefined;
  }

  repin(grant: Grant, viewerId: string): void {
    const peerId = grant.a === viewerId ? grant.b : grant.a;
    const peer = this.actors.get(peerId);
    if (!peer) return;
    const pin = { age: peer.agePublicKey, signing: peer.signingPublicKey };
    if (peerId === grant.a) grant.pinA = pin;
    else grant.pinB = pin;
  }

  revoke(grant: Grant): void {
    grant.revoked = true;
  }

  expireDue(): void {
    const t = this.now();
    for (const m of this.messages.values()) {
      if (m.status === "queued" || m.status === "opened") {
        if (m.expiresAt <= t) {
          m.status = "expired";
          m.expiredAt = t;
          m.payload = null;
          m.envelope = { ...m.envelope, body: "" };
        }
      }
    }
  }

  enqueue(envelope: Envelope): { message: StoredMessage; replayed: boolean } {
    this.expireDue();
    const key = `${envelope.from}:${envelope.id}`;
    const existingId = this.idempotency.get(key);
    if (existingId) {
      const existing = this.messages.get(existingId);
      if (!existing) throw new Error("idempotency_orphan");
      const same =
        existing.envelope.body === envelope.body &&
        existing.envelope.to === envelope.to &&
        existing.envelope.intent === envelope.intent &&
        existing.envelope.priority === envelope.priority &&
        existing.envelope.thread_id === envelope.thread_id &&
        existing.envelope.blob_url === envelope.blob_url &&
        existing.envelope.sig === envelope.sig;
      if (!same) {
        throw Object.assign(new Error("idempotency_conflict"), {
          code: "idempotency_conflict",
        });
      }
      return { message: existing, replayed: true };
    }
    if (this.messages.has(envelope.id)) {
      throw Object.assign(new Error("id_taken"), { code: "id_taken" });
    }
    const bytes = Buffer.byteLength(envelope.body, "utf8");
    const stored: StoredMessage = {
      envelope,
      queuedAt: this.now(),
      expiresAt: this.now() + UNREAD_TTL_MS,
      bytes,
      status: "queued",
      payload: envelope.body,
    };
    this.messages.set(envelope.id, stored);
    this.idempotency.set(key, envelope.id);
    return { message: stored, replayed: false };
  }

  unreadCount(actorId: string): number {
    this.expireDue();
    let n = 0;
    for (const m of this.messages.values()) {
      if (m.envelope.to === actorId && (m.status === "queued" || m.status === "opened")) {
        n++;
      }
    }
    return n;
  }

  headers(actorId: string, limit = 100): InboxHeader[] {
    this.expireDue();
    const rows: InboxHeader[] = [];
    for (const m of this.messages.values()) {
      if (m.envelope.to !== actorId) continue;
      if (m.status !== "queued" && m.status !== "opened") continue;
      const env = m.envelope;
      rows.push({
        id: env.id,
        from: env.from,
        to: env.to,
        intent: env.intent as Intent,
        priority: env.priority as Priority,
        thread_id: env.thread_id,
        bytes: m.bytes,
        enc: isAgeArmored(m.payload ?? "") ? "age" : "none",
        created_at: new Date(m.queuedAt).toISOString(),
      });
    }
    return rows
      .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))
      .slice(0, limit);
  }

  open(actorId: string, id: string): StoredMessage | "gone" | "missing" {
    this.expireDue();
    const m = this.messages.get(id);
    if (!m || m.envelope.to !== actorId) return "missing";
    if (m.status === "acked" || m.status === "expired" || m.payload === null) {
      return "gone";
    }
    if (m.status === "queued") {
      m.status = "opened";
      m.openedAt = this.now();
    }
    return m;
  }

  ack(actorId: string, id: string): Receipt | "missing" {
    this.expireDue();
    const m = this.messages.get(id);
    if (!m || m.envelope.to !== actorId) return "missing";
    if (m.status === "expired") {
      return this.receipt(m);
    }
    if (m.status === "acked") {
      return this.receipt(m);
    }
    const actor = this.actors.get(actorId);
    const retain =
      actor?.retention.enabled &&
      actor.retention.ttl_seconds &&
      actor.retention.ttl_seconds > 0;
    m.status = "acked";
    m.ackedAt = this.now();
    if (!retain) {
      m.payload = null;
      m.envelope = { ...m.envelope, body: "" };
    }
    return this.receipt(m);
  }

  receipt(m: StoredMessage): Receipt {
    return {
      id: m.envelope.id,
      from: m.envelope.from,
      to: m.envelope.to,
      acked_at: m.ackedAt ? new Date(m.ackedAt).toISOString() : undefined,
      expired_at: m.expiredAt ? new Date(m.expiredAt).toISOString() : undefined,
      bytes: m.bytes,
      status: m.status === "expired" ? "expired" : "acked",
    };
  }

  setWebhook(actor: Actor, dest: WebhookDest): void {
    actor.webhook = dest;
  }

  clearWebhook(actor: Actor): void {
    delete actor.webhook;
  }

  issueReset(handle: string): { actor: Actor; reset_token: string; expires_at: number } {
    const actor = this.byHandle(handle);
    if (!actor) {
      throw Object.assign(new Error("not_found"), { code: "not_found" });
    }
    const raw = resetToken();
    const expiresAt = this.now() + RESET_TTL_MS;
    this.resetTickets.set(sha256hex(raw), {
      tokenHash: sha256hex(raw),
      handle: actor.handle,
      actorId: actor.actorId,
      expiresAt,
      spent: false,
    });
    return { actor, reset_token: raw, expires_at: expiresAt };
  }

  reclaim(handle: string, resetRaw: string): { actor: Actor; token: string; recovery_secret: string } | null {
    const ticket = this.resetTickets.get(sha256hex(resetRaw));
    if (!ticket || ticket.spent) return null;
    if (ticket.expiresAt <= this.now()) return null;
    if (ticket.handle !== handle) return null;
    const actor = this.actors.get(ticket.actorId);
    if (!actor) return null;
    this.actorsByTokenHash.delete(actor.tokenHash);
    const token = bearerToken();
    const recovery_secret = recoverySecret();
    actor.tokenHash = sha256hex(token);
    actor.recoveryHash = sha256hex(recovery_secret);
    this.actorsByTokenHash.set(actor.tokenHash, actor.actorId);
    delete actor.webhook;
    ticket.spent = true;
    return { actor, token, recovery_secret };
  }

  deleteHandle(handle: string): boolean {
    const actor = this.byHandle(handle);
    if (!actor) return false;
    this.actorsByTokenHash.delete(actor.tokenHash);
    this.actorsByHandle.delete(actor.handle);
    this.actors.delete(actor.actorId);
    for (const [alias, id] of this.aliases) if (id === actor.actorId) this.aliases.delete(alias);
    for (const k of this.shares) if (k.endsWith(`:${actor.actorId}`)) this.shares.delete(k);
    for (const [key, g] of this.grants) {
      if (g.a === actor.actorId || g.b === actor.actorId) {
        g.revoked = true;
        this.grants.delete(key);
      }
    }
    for (const m of this.messages.values()) {
      if (m.envelope.to === actor.actorId && m.payload !== null) {
        m.status = "expired";
        m.expiredAt = this.now();
        m.payload = null;
        m.envelope = { ...m.envelope, body: "" };
      }
    }
    return true;
  }

  private liveReservation(handle: string): Reservation | undefined {
    const r = this.reservations.get(handle);
    if (r && r.expiresAt <= this.now()) {
      this.reservations.delete(handle);
      return undefined;
    }
    return r;
  }

  handleAvailability(handle: string): { available: boolean; reason?: "invalid" | "taken" | "reserved" } {
    if (!HANDLE_RE.test(handle)) return { available: false, reason: "invalid" };
    if (this.nameInUse(handle)) return { available: false, reason: "taken" };
    if (this.liveReservation(handle)) return { available: false, reason: "reserved" };
    return { available: true };
  }

  /** Reserve (or re-reserve, for the same owner) a free handle. */
  reserveHandle(r: Reservation): void {
    if (!HANDLE_RE.test(r.handle)) throw storeError("invalid_handle");
    const ns = splitHandle(r.handle).owner;
    if (ns !== undefined && this.profiles.get(r.ownerId)?.username !== ns) throw storeError("not_your_namespace");
    if (this.nameInUse(r.handle)) throw storeError("handle_taken");
    const existing = this.liveReservation(r.handle);
    if (existing && existing.ownerId !== r.ownerId) throw storeError("handle_taken");
    this.reservations.set(r.handle, { ...r });
  }

  cancelReservation(handle: string, ownerId: string): boolean {
    const r = this.reservations.get(handle);
    if (!r || r.ownerId !== ownerId) return false;
    this.reservations.delete(handle);
    return true;
  }

  listReservations(ownerId: string): Reservation[] {
    return [...this.reservations.values()]
      .filter((r) => r.ownerId === ownerId && r.expiresAt > this.now())
      .sort((a, b) => a.handle.localeCompare(b.handle));
  }

  listOwnedActors(ownerId: string): Actor[] {
    return [...this.actors.values()]
      .filter((a) => a.ownerId === ownerId)
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  getProfile(ownerId: string): Profile {
    return { ...(this.profiles.get(ownerId) ?? { username: null, display_name: null, onboarded_at: null }) };
  }

  updateProfile(ownerId: string, patch: { display_name?: string; onboarded?: boolean }): Profile {
    const p = this.getProfile(ownerId);
    if (patch.display_name !== undefined) p.display_name = patch.display_name;
    if (patch.onboarded && !p.onboarded_at) p.onboarded_at = new Date(this.now()).toISOString();
    this.profiles.set(ownerId, p);
    return { ...p };
  }

  usernameAvailability(name: string, ownerId: string): { available: boolean; reason?: "invalid" | "taken" } {
    if (!USERNAME_RE.test(name)) return { available: false, reason: "invalid" };
    const holder = this.usernameOwner(name);
    if (holder !== undefined) return holder === ownerId ? { available: true } : { available: false, reason: "taken" };
    // A bare agent of yours with this name is fine: it moves to name.main.
    const actor = this.byHandle(name);
    if (actor && actor.ownerId !== ownerId) return { available: false, reason: "taken" };
    const r = this.liveReservation(name);
    if (r && r.ownerId !== ownerId) return { available: false, reason: "taken" };
    return { available: true };
  }

  setUsername(ownerId: string, name: string): { username: string; renamed: Array<{ from: string; to: string }> } {
    const current = this.getProfile(ownerId);
    if (current.username === name) return { username: name, renamed: [] };
    if (current.username) throw storeError("username_set");
    const avail = this.usernameAvailability(name, ownerId);
    if (!avail.available) throw storeError(avail.reason === "invalid" ? "invalid_username" : "username_taken");
    this.profiles.set(ownerId, { ...current, username: name });
    this.reservations.delete(name);
    const renamed: Array<{ from: string; to: string }> = [];
    for (const a of this.listOwnedActors(ownerId)) {
      if (splitHandle(a.handle).owner) continue;
      const from = a.handle;
      const base = `${name}.${from === name ? "main" : from}`;
      let to = base;
      for (let n = 2; this.nameInUse(to) || this.liveReservation(to); n++) to = `${base}-${n}`;
      this.actorsByHandle.delete(from);
      this.actorsByHandle.set(to, a.actorId);
      // The old handle keeps resolving (peers' scripts, recovery). For "nebula"
      // itself, @nebula now names the person and reaches their main agent.
      this.aliases.set(from, a.actorId);
      a.handle = to;
      renamed.push({ from, to });
    }
    this.linkSiblings(ownerId);
    return { username: name, renamed };
  }

  createConnectionInvite(ownerId: string, note?: string): ConnectionInvite {
    const inv: ConnectionInvite = {
      token: connectionInviteToken(),
      fromOwner: ownerId,
      note,
      expiresAt: this.now() + INVITE_TTL_MS,
      accepted: false,
    };
    this.connectionInvites.set(inv.token, inv);
    return inv;
  }

  getConnectionInvite(token: string): ConnectionInvite | undefined {
    return this.connectionInvites.get(token);
  }

  private connectionBetween(x: string, y: string): Connection | undefined {
    for (const c of this.connections.values()) {
      if ((c.ownerA === x && c.ownerB === y) || (c.ownerA === y && c.ownerB === x)) return c;
    }
    return undefined;
  }

  acceptConnectionInvite(token: string, ownerId: string): Connection {
    const inv = this.connectionInvites.get(token);
    if (!inv) throw storeError("unknown_invite");
    if (inv.accepted) throw storeError("invite_spent");
    if (inv.expiresAt <= this.now()) throw storeError("invite_expired");
    if (inv.fromOwner === ownerId) throw storeError("self_redeem");
    if (this.connectionBetween(inv.fromOwner, ownerId)) throw storeError("already_connected");
    inv.accepted = true;
    const [ownerA, ownerB] = inv.fromOwner < ownerId ? [inv.fromOwner, ownerId] : [ownerId, inv.fromOwner];
    const c: Connection = { id: connectionId(this.now()), ownerA, ownerB, createdAt: this.now() };
    this.connections.set(c.id, c);
    return c;
  }

  private sharedBy(connId: string, ownerId: string): Actor[] {
    const out: Actor[] = [];
    for (const k of this.shares) {
      const [cid, aid] = k.split(":");
      const a = cid === connId ? this.actors.get(aid) : undefined;
      if (a && a.ownerId === ownerId) out.push(a);
    }
    return out.sort((x, y) => x.handle.localeCompare(y.handle));
  }

  listConnections(ownerId: string): ConnectionView[] {
    return [...this.connections.values()]
      .filter((c) => c.ownerA === ownerId || c.ownerB === ownerId)
      .sort((x, y) => x.createdAt - y.createdAt)
      .map((c) => {
        const peer = c.ownerA === ownerId ? c.ownerB : c.ownerA;
        return {
          id: c.id,
          peer: { user_id: peer, username: this.getProfile(peer).username },
          mine: this.sharedBy(c.id, ownerId).map((a) => a.handle),
          theirs: this.sharedBy(c.id, peer).map((a) => a.handle),
          created_at: new Date(c.createdAt).toISOString(),
        };
      });
  }

  setShare(ownerId: string, connId: string, actorId: string, shared: boolean): void {
    const c = this.connections.get(connId);
    const actor = this.actors.get(actorId);
    if (!c || (c.ownerA !== ownerId && c.ownerB !== ownerId)) throw storeError("not_found");
    if (!actor || actor.ownerId !== ownerId) throw storeError("not_found");
    const key = `${connId}:${actorId}`;
    if (shared) {
      this.shares.add(key);
      const peer = c.ownerA === ownerId ? c.ownerB : c.ownerA;
      for (const theirs of this.sharedBy(connId, peer)) {
        if (!this.findGrant(actorId, theirs.actorId)) this.newGrant(actor, theirs, connId);
      }
    } else {
      this.shares.delete(key);
      for (const g of this.grants.values()) {
        if (!g.revoked && g.connectionId === connId && (g.a === actorId || g.b === actorId)) g.revoked = true;
      }
    }
  }

  deleteConnection(ownerId: string, connId: string): boolean {
    const c = this.connections.get(connId);
    if (!c || (c.ownerA !== ownerId && c.ownerB !== ownerId)) return false;
    for (const g of this.grants.values()) if (g.connectionId === connId) g.revoked = true;
    for (const k of this.shares) if (k.startsWith(`${connId}:`)) this.shares.delete(k);
    this.connections.delete(connId);
    return true;
  }

  listAgentsPublic(): AgentPublic[] {
    return [...this.actors.values()]
      .sort((a, b) => a.handle.localeCompare(b.handle))
      .map((a) => ({
        handle: a.handle,
        actor_id: a.actorId,
        webhook_connected: Boolean(a.webhook),
        webhook_url: a.webhook?.url,
        auth_mode: a.webhook?.authMode,
        age_published: Boolean(a.agePublicKey),
        signing_published: Boolean(a.signingPublicKey),
        keys_ready: Boolean(a.agePublicKey && a.signingPublicKey),
      }));
  }
}

export type Snapshot = {
  v: 1;
  actors: Actor[];
  invites: Invite[];
  grants: Grant[];
  messages: StoredMessage[];
  idempotency: Array<[string, string]>;
  resetTickets: Array<[string, ResetTicket]>;
  reservations?: Reservation[];
  profiles?: Array<[string, Profile]>;
  aliases?: Array<[string, string]>;
  connections?: Connection[];
  connectionInvites?: ConnectionInvite[];
  shares?: string[];
};

export function snapshotStore(store: MemoryStore): Snapshot {
  return {
    v: 1,
    actors: [...store.actors.values()],
    invites: [...store.invites.values()],
    grants: [...store.grants.values()].filter((g) => !g.revoked),
    messages: [...store.messages.values()],
    idempotency: [...store.idempotency.entries()],
    resetTickets: [...store.resetTickets.entries()],
    reservations: [...store.reservations.values()],
    profiles: [...store.profiles.entries()],
    aliases: [...store.aliases.entries()],
    connections: [...store.connections.values()],
    connectionInvites: [...store.connectionInvites.values()],
    shares: [...store.shares],
  };
}

export function restoreStore(store: MemoryStore, snap: Snapshot): void {
  if (snap.v !== 1) throw new Error(`unsupported snapshot version ${String(snap.v)}`);
  for (const a of snap.actors) {
    store.actors.set(a.actorId, a);
    store.actorsByHandle.set(a.handle, a.actorId);
    store.actorsByTokenHash.set(a.tokenHash, a.actorId);
  }
  for (const i of snap.invites) store.invites.set(i.token, i);
  for (const g of snap.grants) store.grants.set(store.pairKey(g.a, g.b), g);
  for (const m of snap.messages) store.messages.set(m.envelope.id, m);
  for (const [k, v] of snap.idempotency) store.idempotency.set(k, v);
  for (const [k, v] of snap.resetTickets) store.resetTickets.set(k, v);
  for (const r of snap.reservations ?? []) store.reservations.set(r.handle, r);
  for (const [k, v] of snap.profiles ?? []) store.profiles.set(k, { ...v, username: v.username ?? null });
  for (const [k, v] of snap.aliases ?? []) store.aliases.set(k, v);
  for (const c of snap.connections ?? []) store.connections.set(c.id, c);
  for (const i of snap.connectionInvites ?? []) store.connectionInvites.set(i.token, i);
  for (const k of snap.shares ?? []) store.shares.add(k);
}

/** The async Store view of a MemoryStore (what the HTTP app talks to). */
export function asyncStore(mem: MemoryStore): Store {
  const p = <T>(v: T) => Promise.resolve(v);
  return {
    now: () => mem.now(),
    claim: async (handle, opts) => mem.claim(handle, opts),
    recover: async (handle, secret) => mem.recover(handle, secret),
    byToken: async (token) => mem.byToken(token),
    byHandle: async (handle) => mem.byHandle(handle),
    byId: async (id) => mem.byId(id),
    publishAge: async (actor, key) => mem.publishAge(actor, key),
    publishSigning: async (actor, key) => mem.publishSigning(actor, key),
    setRetention: async (actor, r) => mem.setRetention(actor, r),
    createInvite: async (from, note) => mem.createInvite(from, note),
    getInvite: async (token) => mem.getInvite(token),
    redeem: async (token, redeemer) => mem.redeem(token, redeemer),
    findGrant: async (a, b) => mem.findGrant(a, b),
    grantById: async (id, viewer) => mem.grantById(id, viewer),
    grantView: async (g, viewer) => mem.grantView(g, viewer),
    listGrants: async (viewer) => mem.listGrants(viewer),
    repin: async (g, viewer) => mem.repin(g, viewer),
    revoke: async (g) => mem.revoke(g),
    enqueue: async (env) => mem.enqueue(env),
    unreadCount: async (id) => mem.unreadCount(id),
    headers: async (id, limit) => mem.headers(id, limit),
    open: async (actorId, id) => {
      const r = mem.open(actorId, id);
      return r === "gone" ? { gone: mem.receipt(mem.messages.get(id)!) } : r;
    },
    ack: async (actorId, id) => mem.ack(actorId, id),
    expireDue: async () => mem.expireDue(),
    setWebhook: async (actor, dest) => mem.setWebhook(actor, dest),
    clearWebhook: async (actor) => mem.clearWebhook(actor),
    issueReset: async (handle) => mem.issueReset(handle),
    reclaim: async (handle, raw) => mem.reclaim(handle, raw),
    deleteHandle: async (handle) => mem.deleteHandle(handle),
    listAgentsPublic: async () => mem.listAgentsPublic(),
    handleAvailability: async (handle) => mem.handleAvailability(handle),
    reserveHandle: async (r) => mem.reserveHandle(r),
    cancelReservation: async (handle, owner) => mem.cancelReservation(handle, owner),
    listReservations: async (owner) => mem.listReservations(owner),
    listOwnedActors: async (owner) => mem.listOwnedActors(owner),
    getProfile: (owner) => p(mem.getProfile(owner)),
    updateProfile: async (owner, patch) => mem.updateProfile(owner, patch),
    usernameAvailability: async (name, owner) => mem.usernameAvailability(name, owner),
    setUsername: async (owner, name) => mem.setUsername(owner, name),
    createConnectionInvite: async (owner, note) => mem.createConnectionInvite(owner, note),
    getConnectionInvite: async (token) => mem.getConnectionInvite(token),
    acceptConnectionInvite: async (token, owner) => mem.acceptConnectionInvite(token, owner),
    listConnections: async (owner) => mem.listConnections(owner),
    setShare: async (owner, conn, actor, shared) => mem.setShare(owner, conn, actor, shared),
    deleteConnection: async (owner, conn) => mem.deleteConnection(owner, conn),
  };
}

export function codeOf(err: unknown): string | undefined {
  if (err && typeof err === "object" && "code" in err) {
    return String((err as { code: string }).code);
  }
  return undefined;
}
