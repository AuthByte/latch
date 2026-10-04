import { fingerprint } from "./crypto.js";
import type { Envelope, GrantView, InboxHeader, Receipt } from "./types.js";
import type { WebhookDest } from "./webhooks.js";

export type Retention = {
  enabled: boolean;
  ttl_seconds: number | null;
};

export type Actor = {
  actorId: string;
  handle: string;
  tokenHash: string;
  recoveryHash: string;
  agePublicKey?: string;
  signingPublicKey?: string;
  retention: Retention;
  createdAt: number;
  webhook?: WebhookDest;
  /** Supabase auth user that owns this agent, if it was claimed through the dashboard. */
  ownerId?: string;
};

export type Invite = {
  token: string;
  fromActorId: string;
  note?: string;
  expiresAt: number;
  redeemed: boolean;
};

export type Pin = { age?: string; signing?: string };

export type Grant = {
  id: string;
  a: string;
  b: string;
  pinA: Pin;
  pinB: Pin;
  createdAt: number;
  revoked: boolean;
};

export type StoredMessage = {
  envelope: Envelope;
  queuedAt: number;
  expiresAt: number;
  openedAt?: number;
  ackedAt?: number;
  expiredAt?: number;
  bytes: number;
  status: "queued" | "opened" | "acked" | "expired";
  payload: string | null;
};

export type ResetTicket = {
  tokenHash: string;
  handle: string;
  actorId: string;
  expiresAt: number;
  spent: boolean;
};

export type Reservation = {
  handle: string;
  ownerId: string;
  codeHash: string;
  expiresAt: number;
};

export type Profile = {
  display_name: string | null;
  onboarded_at: string | null;
};

export type AgentPublic = {
  handle: string;
  actor_id: string;
  webhook_connected: boolean;
  webhook_url?: string;
  auth_mode?: WebhookDest["authMode"];
  age_published: boolean;
  signing_published: boolean;
  keys_ready: boolean;
};

export type OpenResult = StoredMessage | { gone: Receipt } | "missing";

/**
 * Everything the HTTP layer needs from storage. MemoryStore (tests, local dev,
 * file snapshots) and PgStore (Supabase Postgres) both implement it. Errors are
 * thrown as Error objects with a `code` (see codeOf in store.ts).
 */
export interface Store {
  now(): number;

  claim(
    handle: string,
    opts?: { recovery?: string; setupCodeHash?: string },
  ): Promise<{ actor: Actor; token: string; recovery_secret: string }>;
  recover(handle: string, secret: string): Promise<{ actor: Actor; token: string } | null>;
  byToken(token: string): Promise<Actor | undefined>;
  byHandle(handle: string): Promise<Actor | undefined>;
  byId(id: string): Promise<Actor | undefined>;
  publishAge(actor: Actor, publicKey: string): Promise<void>;
  publishSigning(actor: Actor, publicKey: string): Promise<void>;
  setRetention(actor: Actor, retention: Retention): Promise<void>;

  createInvite(fromActorId: string, note?: string): Promise<Invite>;
  getInvite(token: string): Promise<Invite | undefined>;
  redeem(token: string, redeemer: Actor): Promise<Grant>;

  findGrant(a: string, b: string): Promise<Grant | undefined>;
  grantById(id: string, viewerId: string): Promise<Grant | undefined>;
  grantView(grant: Grant, viewerId: string): Promise<GrantView>;
  listGrants(viewerId: string): Promise<GrantView[]>;
  repin(grant: Grant, viewerId: string): Promise<void>;
  revoke(grant: Grant): Promise<void>;

  enqueue(envelope: Envelope): Promise<{ message: StoredMessage; replayed: boolean }>;
  unreadCount(actorId: string): Promise<number>;
  headers(actorId: string, limit?: number): Promise<InboxHeader[]>;
  open(actorId: string, id: string): Promise<OpenResult>;
  ack(actorId: string, id: string): Promise<Receipt | "missing">;
  expireDue(): Promise<void>;

  setWebhook(actor: Actor, dest: WebhookDest): Promise<void>;
  clearWebhook(actor: Actor): Promise<void>;

  issueReset(handle: string): Promise<{ actor: Actor; reset_token: string; expires_at: number }>;
  reclaim(
    handle: string,
    resetRaw: string,
  ): Promise<{ actor: Actor; token: string; recovery_secret: string } | null>;
  deleteHandle(handle: string): Promise<boolean>;
  listAgentsPublic(): Promise<AgentPublic[]>;

  // Owners (dashboard)
  handleAvailability(handle: string): Promise<{ available: boolean; reason?: "invalid" | "taken" | "reserved" }>;
  reserveHandle(r: Reservation): Promise<void>;
  cancelReservation(handle: string, ownerId: string): Promise<boolean>;
  listReservations(ownerId: string): Promise<Reservation[]>;
  listOwnedActors(ownerId: string): Promise<Actor[]>;
  getProfile(ownerId: string): Promise<Profile>;
  updateProfile(ownerId: string, patch: { display_name?: string; onboarded?: boolean }): Promise<Profile>;
}

export function storeError(code: string): Error {
  return Object.assign(new Error(code), { code });
}

/** The key the peer pinned for `actorId`. */
export function pinFor(grant: Grant, actorId: string): Pin {
  return actorId === grant.a ? grant.pinA : grant.pinB;
}

function pinMatches(pin: Pin, actor: Actor | undefined): boolean {
  return Boolean(
    actor && pin.age === actor.agePublicKey && pin.signing === actor.signingPublicKey,
  );
}

/**
 * `key_changed`: the peer's keys moved and the viewer must re-verify and repin.
 * `awaiting_peer_repin`: the viewer's own keys moved and the peer has to repin.
 * Mail is blocked both ways in either state.
 */
export function grantStatus(
  grant: Grant,
  viewerId: string,
  viewer: Actor | undefined,
  peer: Actor | undefined,
): GrantView["status"] {
  const peerId = grant.a === viewerId ? grant.b : grant.a;
  if (!pinMatches(pinFor(grant, peerId), peer)) return "key_changed";
  if (!pinMatches(pinFor(grant, viewerId), viewer)) return "awaiting_peer_repin";
  return "active";
}

export function computeGrantView(
  grant: Grant,
  viewerId: string,
  viewer: Actor | undefined,
  peer: Actor | undefined,
): GrantView {
  const peerId = grant.a === viewerId ? grant.b : grant.a;
  const pin = pinFor(grant, peerId);
  return {
    grant_id: grant.id,
    peer: { actor_id: peerId, handle: peer?.handle ?? "unknown" },
    pinned_age_key: pin.age,
    pinned_signing_key: pin.signing,
    status: grantStatus(grant, viewerId, viewer, peer),
    created_at: new Date(grant.createdAt).toISOString(),
  };
}

export function fingerprintsOf(keys: { age?: string | null; signing?: string | null }) {
  return {
    signing: keys.signing ? fingerprint(keys.signing) : undefined,
    age: keys.age ? fingerprint(keys.age) : undefined,
  };
}

export const AGE_KEY_RE = /^age1[0-9a-z]{58}$/;
export const SIGNING_KEY_RE = /^ed25519:[A-Za-z0-9_-]{43}$/;
