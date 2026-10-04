import { sha256hex } from "./crypto.js";
import {
  actorId as newActorId,
  bearerToken,
  grantId,
  HANDLE_RE,
  inviteToken,
  recoverySecret,
  resetToken,
} from "./ids.js";
import {
  AGE_KEY_RE,
  computeGrantView,
  SIGNING_KEY_RE,
  storeError,
  type Actor,
  type AgentPublic,
  type Grant,
  type Invite,
  type OpenResult,
  type Profile,
  type Reservation,
  type Retention,
  type Store,
  type StoredMessage,
} from "./store-types.js";
import {
  INVITE_TTL_MS,
  RESET_TTL_MS,
  UNREAD_TTL_MS,
  isAgeArmored,
  type Envelope,
  type GrantView,
  type InboxHeader,
  type Intent,
  type Priority,
  type Receipt,
} from "./types.js";
import type { WebhookDest } from "./webhooks.js";

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** The few things PgStore needs from a Postgres driver (postgres.js in prod, PGlite in tests). */
export interface Db {
  query<T extends Row = Row>(text: string, params?: unknown[]): Promise<T[]>;
  tx<T>(fn: (db: Db) => Promise<T>): Promise<T>;
}

type PostgresJs = {
  unsafe(text: string, params?: unknown[]): PromiseLike<Row[]>;
  begin<T>(fn: (sql: PostgresJs) => Promise<T>): Promise<T>;
};

export function postgresJsDb(sql: PostgresJs): Db {
  return {
    query: async <T extends Row>(text: string, params: unknown[] = []) =>
      [...(await sql.unsafe(text, params as never[]))] as T[],
    tx: <T>(fn: (db: Db) => Promise<T>) =>
      sql.begin((inner) => fn(postgresJsDb(inner))) as Promise<T>,
  };
}

type PgliteLike = {
  query<T>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
  transaction<T>(fn: (tx: { query: PgliteLike["query"] }) => Promise<T>): Promise<T>;
};

export function pgliteDb(pg: PgliteLike): Db {
  const wrap = (q: { query: PgliteLike["query"] }, nested: boolean): Db => ({
    query: async <T extends Row>(text: string, params: unknown[] = []) =>
      (await q.query<T>(text, params)).rows,
    tx: (fn) => (nested ? fn(wrap(q, true)) : pg.transaction((tx) => fn(wrap(tx, true)))),
  });
  return wrap(pg, false);
}

const ms = (d: Date | string | null | undefined): number | undefined =>
  d == null ? undefined : new Date(d).getTime();
const ts = (n: number): string => new Date(n).toISOString();
const isUnique = (err: unknown) =>
  Boolean(err && typeof err === "object" && (err as { code?: string }).code === "23505");

function toActor(r: Row): Actor {
  const a: Actor = {
    actorId: r.actor_id,
    handle: r.handle,
    tokenHash: r.token_hash,
    recoveryHash: r.recovery_hash,
    retention: { enabled: r.retention_enabled, ttl_seconds: r.retention_ttl_seconds ?? null },
    createdAt: ms(r.created_at)!,
  };
  if (r.age_public_key) a.agePublicKey = r.age_public_key;
  if (r.signing_public_key) a.signingPublicKey = r.signing_public_key;
  if (r.webhook) a.webhook = r.webhook as WebhookDest;
  if (r.owner_id) a.ownerId = r.owner_id;
  return a;
}

function toGrant(r: Row): Grant {
  const pin = (age: string | null, signing: string | null) => ({
    ...(age ? { age } : {}),
    ...(signing ? { signing } : {}),
  });
  return {
    id: r.id,
    a: r.a,
    b: r.b,
    pinA: pin(r.pin_a_age, r.pin_a_signing),
    pinB: pin(r.pin_b_age, r.pin_b_signing),
    createdAt: ms(r.created_at)!,
    revoked: r.revoked,
  };
}

function toMessage(r: Row): StoredMessage {
  return {
    envelope: r.envelope as Envelope,
    queuedAt: ms(r.queued_at)!,
    expiresAt: ms(r.expires_at)!,
    openedAt: ms(r.opened_at),
    ackedAt: ms(r.acked_at),
    expiredAt: ms(r.expired_at),
    bytes: r.bytes,
    status: r.status,
    payload: r.payload,
  };
}

function receipt(m: StoredMessage): Receipt {
  return {
    id: m.envelope.id,
    from: m.envelope.from,
    to: m.envelope.to,
    acked_at: m.ackedAt ? ts(m.ackedAt) : undefined,
    expired_at: m.expiredAt ? ts(m.expiredAt) : undefined,
    bytes: m.bytes,
    status: m.status === "expired" ? "expired" : "acked",
  };
}

const LIVE = `status in ('queued', 'opened')`;

export class PgStore implements Store {
  constructor(
    private db: Db,
    private clock: () => number = () => Date.now(),
  ) {}

  now(): number {
    return this.clock();
  }

  private async one<T extends Row = Row>(db: Db, text: string, params: unknown[]): Promise<T | undefined> {
    return (await db.query<T>(text, params))[0];
  }

  async claim(
    handle: string,
    opts: { recovery?: string; setupCodeHash?: string } = {},
  ): Promise<{ actor: Actor; token: string; recovery_secret: string }> {
    if (!HANDLE_RE.test(handle)) throw storeError("invalid_handle");
    const token = bearerToken();
    const recovery_secret =
      opts.recovery && opts.recovery.length >= 16 ? opts.recovery : recoverySecret();
    const now = this.now();
    try {
      return await this.db.tx(async (db) => {
        if (await this.one(db, `select 1 from latch.actors where handle = $1`, [handle])) {
          throw storeError("handle_taken");
        }
        const r = await this.one(
          db,
          `select owner_id, code_hash from latch.reservations where handle = $1 and expires_at > $2::timestamptz for update`,
          [handle, ts(now)],
        );
        if (opts.setupCodeHash !== undefined && (!r || r.code_hash !== opts.setupCodeHash)) {
          throw storeError("bad_setup_code");
        }
        if (r && opts.setupCodeHash === undefined) throw storeError("handle_reserved");
        const row = await this.one(
          db,
          `insert into latch.actors (actor_id, handle, token_hash, recovery_hash, owner_id, created_at)
           values ($1, $2, $3, $4, $5, $6::timestamptz) returning *`,
          [newActorId(now), handle, sha256hex(token), sha256hex(recovery_secret), r?.owner_id ?? null, ts(now)],
        );
        await db.query(`delete from latch.reservations where handle = $1`, [handle]);
        return { actor: toActor(row!), token, recovery_secret };
      });
    } catch (err) {
      if (isUnique(err)) throw storeError("handle_taken");
      throw err;
    }
  }

  async recover(handle: string, secret: string): Promise<{ actor: Actor; token: string } | null> {
    const actor = await this.byHandle(handle);
    if (!actor || sha256hex(secret) !== actor.recoveryHash) return null;
    const token = bearerToken();
    actor.tokenHash = sha256hex(token);
    await this.db.query(`update latch.actors set token_hash = $2 where actor_id = $1`, [
      actor.actorId,
      actor.tokenHash,
    ]);
    return { actor, token };
  }

  async byToken(token: string): Promise<Actor | undefined> {
    const r = await this.one(this.db, `select * from latch.actors where token_hash = $1`, [sha256hex(token)]);
    return r && toActor(r);
  }

  async byHandle(handle: string): Promise<Actor | undefined> {
    const r = await this.one(this.db, `select * from latch.actors where handle = $1`, [handle]);
    return r && toActor(r);
  }

  async byId(id: string): Promise<Actor | undefined> {
    const r = await this.one(this.db, `select * from latch.actors where actor_id = $1`, [id]);
    return r && toActor(r);
  }

  private async publish(actor: Actor, slot: "age" | "signing", key: string): Promise<void> {
    const col = slot === "age" ? "age_public_key" : "signing_public_key";
    await this.db.tx(async (db) => {
      await db.query(`update latch.actors set ${col} = $2 where actor_id = $1`, [actor.actorId, key]);
      // Fill empty pins only (first key after a keyless redeem); never overwrite one.
      await db.query(
        `update latch.grants set pin_a_${slot} = $2 where a = $1 and not revoked and pin_a_${slot} is null`,
        [actor.actorId, key],
      );
      await db.query(
        `update latch.grants set pin_b_${slot} = $2 where b = $1 and not revoked and pin_b_${slot} is null`,
        [actor.actorId, key],
      );
    });
  }

  async publishAge(actor: Actor, publicKey: string): Promise<void> {
    if (!AGE_KEY_RE.test(publicKey)) throw storeError("invalid_age_key");
    await this.publish(actor, "age", publicKey);
    actor.agePublicKey = publicKey;
  }

  async publishSigning(actor: Actor, publicKey: string): Promise<void> {
    if (!SIGNING_KEY_RE.test(publicKey)) throw storeError("invalid_signing_key");
    await this.publish(actor, "signing", publicKey);
    actor.signingPublicKey = publicKey;
  }

  async setRetention(actor: Actor, retention: Retention): Promise<void> {
    await this.db.query(
      `update latch.actors set retention_enabled = $2, retention_ttl_seconds = $3 where actor_id = $1`,
      [actor.actorId, retention.enabled, retention.ttl_seconds],
    );
    actor.retention = retention;
  }

  async createInvite(fromActorId: string, note?: string): Promise<Invite> {
    const inv: Invite = {
      token: inviteToken(),
      fromActorId,
      note,
      expiresAt: this.now() + INVITE_TTL_MS,
      redeemed: false,
    };
    await this.db.query(
      `insert into latch.invites (token, from_actor_id, note, expires_at) values ($1, $2, $3, $4::timestamptz)`,
      [inv.token, fromActorId, note ?? null, ts(inv.expiresAt)],
    );
    return inv;
  }

  async getInvite(token: string): Promise<Invite | undefined> {
    const r = await this.one(this.db, `select * from latch.invites where token = $1`, [token]);
    if (!r) return undefined;
    return {
      token: r.token,
      fromActorId: r.from_actor_id,
      note: r.note ?? undefined,
      expiresAt: ms(r.expires_at)!,
      redeemed: r.redeemed,
    };
  }

  async redeem(token: string, redeemer: Actor): Promise<Grant> {
    try {
      return await this.db.tx(async (db) => {
        const inv = await this.one(db, `select * from latch.invites where token = $1 for update`, [token]);
        if (!inv) throw storeError("unknown_invite");
        if (inv.redeemed) throw storeError("invite_spent");
        if (ms(inv.expires_at)! <= this.now()) throw storeError("invite_expired");
        if (inv.from_actor_id === redeemer.actorId) throw storeError("self_redeem");
        const issuerRow = await this.one(db, `select * from latch.actors where actor_id = $1`, [inv.from_actor_id]);
        if (!issuerRow) throw storeError("unknown_invite");
        const issuer = toActor(issuerRow);
        const me = (await this.one(db, `select * from latch.actors where actor_id = $1`, [redeemer.actorId])) ?? null;
        const fresh = me ? toActor(me) : redeemer;
        const [a, b] = issuer.actorId < fresh.actorId ? [issuer, fresh] : [fresh, issuer];
        if (await this.one(db, `select 1 from latch.grants where a = $1 and b = $2 and not revoked`, [a.actorId, b.actorId])) {
          throw storeError("already_granted");
        }
        await db.query(`update latch.invites set redeemed = true where token = $1`, [token]);
        const row = await this.one(
          db,
          `insert into latch.grants (id, a, b, pin_a_age, pin_a_signing, pin_b_age, pin_b_signing, created_at)
           values ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz) returning *`,
          [
            grantId(this.now()),
            a.actorId,
            b.actorId,
            a.agePublicKey ?? null,
            a.signingPublicKey ?? null,
            b.agePublicKey ?? null,
            b.signingPublicKey ?? null,
            ts(this.now()),
          ],
        );
        return toGrant(row!);
      });
    } catch (err) {
      if (isUnique(err)) throw storeError("already_granted");
      throw err;
    }
  }

  async findGrant(x: string, y: string): Promise<Grant | undefined> {
    const [a, b] = x < y ? [x, y] : [y, x];
    const r = await this.one(this.db, `select * from latch.grants where a = $1 and b = $2 and not revoked`, [a, b]);
    return r && toGrant(r);
  }

  async grantById(id: string, viewerId: string): Promise<Grant | undefined> {
    const r = await this.one(
      this.db,
      `select * from latch.grants where id = $1 and not revoked and (a = $2 or b = $2)`,
      [id, viewerId],
    );
    return r && toGrant(r);
  }

  async grantView(grant: Grant, viewerId: string): Promise<GrantView> {
    const peerId = grant.a === viewerId ? grant.b : grant.a;
    const [viewer, peer] = await Promise.all([this.byId(viewerId), this.byId(peerId)]);
    return computeGrantView(grant, viewerId, viewer, peer);
  }

  async listGrants(viewerId: string): Promise<GrantView[]> {
    const grants = (
      await this.db.query(
        `select * from latch.grants where (a = $1 or b = $1) and not revoked order by created_at, id`,
        [viewerId],
      )
    ).map(toGrant);
    if (grants.length === 0) return [];
    const ids = [...new Set(grants.flatMap((g) => [g.a, g.b]))];
    const actors = new Map(
      (
        await this.db.query(
          `select * from latch.actors where actor_id in (select jsonb_array_elements_text($1::jsonb))`,
          [JSON.stringify(ids)],
        )
      ).map((r) => [r.actor_id as string, toActor(r)]),
    );
    return grants.map((g) =>
      computeGrantView(g, viewerId, actors.get(viewerId), actors.get(g.a === viewerId ? g.b : g.a)),
    );
  }

  async repin(grant: Grant, viewerId: string): Promise<void> {
    const peerId = grant.a === viewerId ? grant.b : grant.a;
    const peer = await this.byId(peerId);
    if (!peer) return;
    const side = peerId === grant.a ? "a" : "b";
    await this.db.query(
      `update latch.grants set pin_${side}_age = $2, pin_${side}_signing = $3 where id = $1`,
      [grant.id, peer.agePublicKey ?? null, peer.signingPublicKey ?? null],
    );
    const pin = { age: peer.agePublicKey, signing: peer.signingPublicKey };
    if (side === "a") grant.pinA = pin;
    else grant.pinB = pin;
  }

  async revoke(grant: Grant): Promise<void> {
    await this.db.query(`update latch.grants set revoked = true where id = $1`, [grant.id]);
    grant.revoked = true;
  }

  async expireDue(): Promise<void> {
    const now = ts(this.now());
    await this.db.query(
      `update latch.messages
         set status = 'expired', expired_at = $1::timestamptz, payload = null,
             envelope = envelope || '{"body": ""}'::jsonb
       where ${LIVE} and expires_at <= $1::timestamptz`,
      [now],
    );
  }

  async enqueue(envelope: Envelope): Promise<{ message: StoredMessage; replayed: boolean }> {
    await this.expireDue();
    const replay = async () => {
      const r = await this.one(this.db, `select * from latch.messages where id = $1`, [envelope.id]);
      if (!r) return undefined;
      const existing = toMessage(r);
      if (existing.envelope.from !== envelope.from) throw storeError("id_taken");
      const e = existing.envelope;
      const same =
        e.body === envelope.body &&
        e.to === envelope.to &&
        e.intent === envelope.intent &&
        e.priority === envelope.priority &&
        e.thread_id === envelope.thread_id &&
        e.blob_url === envelope.blob_url &&
        e.sig === envelope.sig;
      if (!same) throw storeError("idempotency_conflict");
      return { message: existing, replayed: true };
    };
    const prior = await replay();
    if (prior) return prior;
    const now = this.now();
    const stored: StoredMessage = {
      envelope,
      queuedAt: now,
      expiresAt: now + UNREAD_TTL_MS,
      bytes: Buffer.byteLength(envelope.body, "utf8"),
      status: "queued",
      payload: envelope.body,
    };
    try {
      await this.db.query(
        `insert into latch.messages (id, from_actor, to_actor, envelope, payload, bytes, status, queued_at, expires_at)
         values ($1, $2, $3, $4::jsonb, $5, $6, 'queued', $7::timestamptz, $8::timestamptz)`,
        [
          envelope.id,
          envelope.from,
          envelope.to,
          JSON.stringify(envelope),
          envelope.body,
          stored.bytes,
          ts(stored.queuedAt),
          ts(stored.expiresAt),
        ],
      );
    } catch (err) {
      if (!isUnique(err)) throw err;
      const raced = await replay();
      if (raced) return raced;
      throw storeError("id_taken");
    }
    return { message: stored, replayed: false };
  }

  async unreadCount(actorId: string): Promise<number> {
    await this.expireDue();
    const r = await this.one(
      this.db,
      `select count(*)::int as n from latch.messages where to_actor = $1 and ${LIVE}`,
      [actorId],
    );
    return Number(r?.n ?? 0);
  }

  async headers(actorId: string, limit = 100): Promise<InboxHeader[]> {
    await this.expireDue();
    const rows = await this.db.query(
      `select * from latch.messages where to_actor = $1 and ${LIVE} order by queued_at, id limit $2`,
      [actorId, limit],
    );
    return rows.map((r) => {
      const m = toMessage(r);
      const env = m.envelope;
      return {
        id: env.id,
        from: env.from,
        to: env.to,
        intent: env.intent as Intent,
        priority: env.priority as Priority,
        thread_id: env.thread_id,
        bytes: m.bytes,
        enc: isAgeArmored(m.payload ?? "") ? "age" : "none",
        created_at: ts(m.queuedAt),
      };
    });
  }

  async open(actorId: string, id: string): Promise<OpenResult> {
    await this.expireDue();
    const r = await this.one(this.db, `select * from latch.messages where id = $1 and to_actor = $2`, [id, actorId]);
    if (!r) return "missing";
    const m = toMessage(r);
    if (m.status === "acked" || m.status === "expired" || m.payload === null) {
      return { gone: receipt(m) };
    }
    if (m.status === "queued") {
      m.status = "opened";
      m.openedAt = this.now();
      await this.db.query(
        `update latch.messages set status = 'opened', opened_at = $2::timestamptz where id = $1 and status = 'queued'`,
        [id, ts(m.openedAt)],
      );
    }
    return m;
  }

  async ack(actorId: string, id: string): Promise<Receipt | "missing"> {
    await this.expireDue();
    const r = await this.one(this.db, `select * from latch.messages where id = $1 and to_actor = $2`, [id, actorId]);
    if (!r) return "missing";
    const m = toMessage(r);
    if (m.status === "expired" || m.status === "acked") return receipt(m);
    const actor = await this.byId(actorId);
    const retain = Boolean(
      actor?.retention.enabled && actor.retention.ttl_seconds && actor.retention.ttl_seconds > 0,
    );
    m.status = "acked";
    m.ackedAt = this.now();
    await this.db.query(
      retain
        ? `update latch.messages set status = 'acked', acked_at = $2::timestamptz where id = $1`
        : `update latch.messages set status = 'acked', acked_at = $2::timestamptz, payload = null,
             envelope = envelope || '{"body": ""}'::jsonb where id = $1`,
      [id, ts(m.ackedAt)],
    );
    return receipt(m);
  }

  async setWebhook(actor: Actor, dest: WebhookDest): Promise<void> {
    await this.db.query(`update latch.actors set webhook = $2::jsonb where actor_id = $1`, [
      actor.actorId,
      JSON.stringify(dest),
    ]);
    actor.webhook = dest;
  }

  async clearWebhook(actor: Actor): Promise<void> {
    await this.db.query(`update latch.actors set webhook = null where actor_id = $1`, [actor.actorId]);
    delete actor.webhook;
  }

  async issueReset(handle: string): Promise<{ actor: Actor; reset_token: string; expires_at: number }> {
    const actor = await this.byHandle(handle);
    if (!actor) throw storeError("not_found");
    const raw = resetToken();
    const expiresAt = this.now() + RESET_TTL_MS;
    await this.db.query(
      `insert into latch.reset_tickets (token_hash, handle, actor_id, expires_at) values ($1, $2, $3, $4::timestamptz)`,
      [sha256hex(raw), actor.handle, actor.actorId, ts(expiresAt)],
    );
    return { actor, reset_token: raw, expires_at: expiresAt };
  }

  async reclaim(
    handle: string,
    resetRaw: string,
  ): Promise<{ actor: Actor; token: string; recovery_secret: string } | null> {
    return this.db.tx(async (db) => {
      const t = await this.one(db, `select * from latch.reset_tickets where token_hash = $1 for update`, [
        sha256hex(resetRaw),
      ]);
      if (!t || t.spent || ms(t.expires_at)! <= this.now() || t.handle !== handle) return null;
      const token = bearerToken();
      const recovery_secret = recoverySecret();
      const row = await this.one(
        db,
        `update latch.actors set token_hash = $2, recovery_hash = $3, webhook = null where actor_id = $1 returning *`,
        [t.actor_id, sha256hex(token), sha256hex(recovery_secret)],
      );
      if (!row) return null;
      await db.query(`update latch.reset_tickets set spent = true where token_hash = $1`, [t.token_hash]);
      return { actor: toActor(row), token, recovery_secret };
    });
  }

  async deleteHandle(handle: string): Promise<boolean> {
    return this.db.tx(async (db) => {
      const r = await this.one(db, `select actor_id from latch.actors where handle = $1`, [handle]);
      if (!r) return false;
      await db.query(
        `update latch.messages set status = 'expired', expired_at = $2::timestamptz, payload = null,
           envelope = envelope || '{"body": ""}'::jsonb
         where to_actor = $1 and payload is not null`,
        [r.actor_id, ts(this.now())],
      );
      // Grants, invites and reset tickets cascade.
      await db.query(`delete from latch.actors where actor_id = $1`, [r.actor_id]);
      return true;
    });
  }

  async listAgentsPublic(): Promise<AgentPublic[]> {
    const rows = await this.db.query(`select * from latch.actors order by handle`);
    return rows.map(toActor).map((a) => ({
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

  async handleAvailability(
    handle: string,
  ): Promise<{ available: boolean; reason?: "invalid" | "taken" | "reserved" }> {
    if (!HANDLE_RE.test(handle)) return { available: false, reason: "invalid" };
    if (await this.one(this.db, `select 1 from latch.actors where handle = $1`, [handle])) {
      return { available: false, reason: "taken" };
    }
    if (
      await this.one(this.db, `select 1 from latch.reservations where handle = $1 and expires_at > $2::timestamptz`, [
        handle,
        ts(this.now()),
      ])
    ) {
      return { available: false, reason: "reserved" };
    }
    return { available: true };
  }

  async reserveHandle(r: Reservation): Promise<void> {
    if (!HANDLE_RE.test(r.handle)) throw storeError("invalid_handle");
    await this.db.tx(async (db) => {
      if (await this.one(db, `select 1 from latch.actors where handle = $1`, [r.handle])) {
        throw storeError("handle_taken");
      }
      const row = await this.one(
        db,
        `insert into latch.reservations (handle, owner_id, code_hash, expires_at)
         values ($1, $2, $3, $4::timestamptz)
         on conflict (handle) do update
           set owner_id = excluded.owner_id, code_hash = excluded.code_hash, expires_at = excluded.expires_at
           where latch.reservations.owner_id = excluded.owner_id or latch.reservations.expires_at <= $5::timestamptz
         returning handle`,
        [r.handle, r.ownerId, r.codeHash, ts(r.expiresAt), ts(this.now())],
      );
      if (!row) throw storeError("handle_taken");
    });
  }

  async cancelReservation(handle: string, ownerId: string): Promise<boolean> {
    const rows = await this.db.query(
      `delete from latch.reservations where handle = $1 and owner_id = $2 returning handle`,
      [handle, ownerId],
    );
    return rows.length > 0;
  }

  async listReservations(ownerId: string): Promise<Reservation[]> {
    const rows = await this.db.query(
      `select * from latch.reservations where owner_id = $1 and expires_at > $2::timestamptz order by handle`,
      [ownerId, ts(this.now())],
    );
    return rows.map((r) => ({
      handle: r.handle,
      ownerId: r.owner_id,
      codeHash: r.code_hash,
      expiresAt: ms(r.expires_at)!,
    }));
  }

  async listOwnedActors(ownerId: string): Promise<Actor[]> {
    const rows = await this.db.query(`select * from latch.actors where owner_id = $1 order by created_at`, [ownerId]);
    return rows.map(toActor);
  }

  async getProfile(ownerId: string): Promise<Profile> {
    const r = await this.one(this.db, `select * from latch.profiles where user_id = $1`, [ownerId]);
    return {
      display_name: r?.display_name ?? null,
      onboarded_at: r?.onboarded_at ? ts(ms(r.onboarded_at)!) : null,
    };
  }

  async updateProfile(ownerId: string, patch: { display_name?: string; onboarded?: boolean }): Promise<Profile> {
    const r = await this.one(
      this.db,
      `insert into latch.profiles (user_id, display_name, onboarded_at) values ($1, $2, $3::timestamptz)
       on conflict (user_id) do update set
         display_name = coalesce($2, latch.profiles.display_name),
         onboarded_at = coalesce(latch.profiles.onboarded_at, $3::timestamptz)
       returning *`,
      [ownerId, patch.display_name ?? null, patch.onboarded ? ts(this.now()) : null],
    );
    return {
      display_name: r?.display_name ?? null,
      onboarded_at: r?.onboarded_at ? ts(ms(r.onboarded_at)!) : null,
    };
  }
}
