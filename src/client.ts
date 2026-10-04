import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { canonicalEnvelope } from "./canonical.js";
import {
  ageDecrypt,
  ageEncrypt,
  fingerprint,
  generateAge,
  generateSigning,
  looksLikeAge,
  signCanonical,
  verifyCanonical,
} from "./crypto.js";
import { messageId } from "./ids.js";
import type { AuthMode, Envelope, GrantView, InboxHeader, Intent, Priority, Receipt } from "./types.js";

export const DEFAULT_URL = "http://127.0.0.1:8787";

export type Creds = {
  url: string;
  handle: string;
  actor_id: string;
  token: string;
  recovery_secret: string;
  signing_private_pem?: string;
  signing_public_key?: string;
  age_identity?: string;
  age_public_key?: string;
};

export class LatchError extends Error {
  constructor(
    public code: string,
    message: string,
    public status?: number,
  ) {
    super(message);
  }
}

/**
 * Where credentials live. Explicit path > LATCH_CREDS > --as/LATCH_AS profile
 * (~/.latch/<handle>.json) > ./.latch.json if present > ~/.latch/credentials.json.
 */
export function resolveCredsPath(opts?: { path?: string; as?: string }): string {
  if (opts?.path) return opts.path;
  if (process.env.LATCH_CREDS) return process.env.LATCH_CREDS;
  const as = opts?.as ?? process.env.LATCH_AS;
  if (as) return join(homedir(), ".latch", `${as}.json`);
  const local = join(process.cwd(), ".latch.json");
  if (existsSync(local)) return local;
  return join(homedir(), ".latch", "credentials.json");
}

export function readCreds(path: string): Creds | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as Creds;
}

/** Atomic write, mode 600. Secrets hit disk before anything reports success. */
export function writeCreds(path: string, creds: Creds): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(creds, null, 2), { mode: 0o600 });
  renameSync(tmp, path);
}

type Json = Record<string, unknown>;

async function call(
  base: string,
  method: string,
  path: string,
  opts?: { token?: string; body?: unknown },
): Promise<Json> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (opts?.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts?.body !== undefined) headers["content-type"] = "application/json";
  let res: Response;
  try {
    res = await fetch(`${base.replace(/\/$/, "")}${path}`, {
      method,
      headers,
      body: opts?.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    throw new LatchError(
      "unreachable",
      `Cannot reach Latch server at ${base} (${err instanceof Error ? err.message : String(err)}). Set LATCH_URL or start it with: npm run dev`,
    );
  }
  const text = await res.text();
  let json: Json = {};
  if (text) {
    try {
      json = JSON.parse(text) as Json;
    } catch {
      json = { raw: text };
    }
  }
  if (!res.ok) {
    const code = typeof json.error === "string" ? json.error : `http_${res.status}`;
    const hint = typeof json.hint === "string" ? json.hint : text || res.statusText;
    const err = new LatchError(code, hint, res.status);
    (err as LatchError & { body?: Json }).body = json;
    throw err;
  }
  return json;
}

export type RegisterResult = { client: LatchClient; webhook?: unknown };

export type OpenedMessage = {
  id: string;
  from: string;
  from_handle: string;
  intent: Intent;
  priority: Priority;
  thread_id?: string;
  blob_url?: string;
  text: string;
  encrypted: boolean;
  /** Ed25519 signature checked locally against the key you pinned for the sender. */
  verified: true;
};

export type SendOptions = {
  intent?: Intent;
  priority?: Priority;
  thread?: string;
  blobUrl?: string;
};

export type Fingerprints = { signing?: string; age?: string };

export type Status = {
  server: string;
  handle: string;
  actor_id: string;
  creds_path: string;
  keys_ready: boolean;
  fingerprints: Fingerprints;
  webhook: unknown;
  unread: number;
  peers: Array<{ handle: string; status: GrantView["status"] }>;
  problems: string[];
};

export class LatchClient {
  private grantsCache: GrantView[] | undefined;

  constructor(
    public creds: Creds,
    public credsPath: string,
  ) {}

  static load(opts?: { path?: string; as?: string; url?: string }): LatchClient {
    const path = resolveCredsPath(opts);
    const creds = readCreds(path);
    if (!creds) {
      throw new LatchError(
        "no_credentials",
        `No credentials at ${path}. Run: latch claim <handle>`,
      );
    }
    if (opts?.url) creds.url = opts.url;
    else if (process.env.LATCH_URL) creds.url = process.env.LATCH_URL;
    return new LatchClient(creds, path);
  }

  /** Claim a new handle, store secrets, publish keys. */
  static async claim(
    handle: string,
    opts?: { url?: string; path?: string; as?: string; setupCode?: string },
  ): Promise<LatchClient> {
    const url = opts?.url ?? process.env.LATCH_URL ?? DEFAULT_URL;
    const path = resolveCredsPath({ path: opts?.path, as: opts?.as });
    guardOverwrite(path, handle);
    const body: Json = { handle };
    if (opts?.setupCode) body.setup_code = opts.setupCode;
    const j = await call(url, "POST", "/v0/handles/claim", { body });
    const client = LatchClient.fromRegistration(url, path, j);
    await client.ensureKeys();
    return client;
  }

  /** Claim through /v0/join (fleet join code and/or webhook in one step). */
  static async join(
    handle: string,
    opts: {
      url?: string;
      path?: string;
      as?: string;
      joinCode?: string;
      webhook?: { url: string; authMode?: AuthMode; secret?: string; authorization?: string };
    },
  ): Promise<RegisterResult> {
    const url = opts.url ?? process.env.LATCH_URL ?? DEFAULT_URL;
    const path = resolveCredsPath({ path: opts.path, as: opts.as });
    guardOverwrite(path, handle);
    const body: Json = { handle };
    if (opts.joinCode) body.join_code = opts.joinCode;
    if (opts.webhook) {
      body.webhook_url = opts.webhook.url;
      if (opts.webhook.authMode) body.webhook_auth_mode = opts.webhook.authMode;
      if (opts.webhook.secret) body.webhook_secret = opts.webhook.secret;
      if (opts.webhook.authorization) body.webhook_authorization = opts.webhook.authorization;
    }
    const j = await call(url, "POST", "/v0/join", { body });
    const client = LatchClient.fromRegistration(url, path, j);
    await client.ensureKeys();
    return { client, webhook: j.webhook };
  }

  /** New bearer from the recovery secret. Reuses local keys for the same actor if present. */
  static async recover(
    handle: string,
    recoverySecret: string,
    opts?: { url?: string; path?: string; as?: string },
  ): Promise<LatchClient> {
    const url = opts?.url ?? process.env.LATCH_URL ?? DEFAULT_URL;
    const path = resolveCredsPath({ path: opts?.path, as: opts?.as });
    const j = await call(url, "POST", "/v0/handles/recover", {
      body: { handle, recovery_secret: recoverySecret },
    });
    const client = LatchClient.fromRegistration(url, path, { ...j, recovery_secret: recoverySecret });
    await client.ensureKeys();
    return client;
  }

  /** Operator-issued one-time reset. Rotates bearer + recovery and clears the webhook. */
  static async reclaim(
    handle: string,
    resetToken: string,
    opts?: { url?: string; path?: string; as?: string },
  ): Promise<LatchClient> {
    const url = opts?.url ?? process.env.LATCH_URL ?? DEFAULT_URL;
    const path = resolveCredsPath({ path: opts?.path, as: opts?.as });
    const j = await call(url, "POST", "/v0/handles/reclaim", {
      body: { handle, reset_token: resetToken },
    });
    const client = LatchClient.fromRegistration(url, path, j);
    await client.ensureKeys();
    return client;
  }

  /** Persist the fresh secrets first, keeping local keys only if they belong to this same actor. */
  private static fromRegistration(url: string, path: string, j: Json): LatchClient {
    const existing = readCreds(path);
    const sameActor = existing && existing.actor_id === j.actor_id;
    const creds: Creds = {
      url,
      handle: String(j.handle),
      actor_id: String(j.actor_id),
      token: String(j.token),
      recovery_secret: String(j.recovery_secret),
      signing_private_pem: sameActor ? existing.signing_private_pem : undefined,
      signing_public_key: sameActor ? existing.signing_public_key : undefined,
      age_identity: sameActor ? existing.age_identity : undefined,
      age_public_key: sameActor ? existing.age_public_key : undefined,
    };
    writeCreds(path, creds);
    return new LatchClient(creds, path);
  }

  private api(method: string, path: string, body?: unknown): Promise<Json> {
    return call(this.creds.url, method, path, { token: this.creds.token, body });
  }

  private save(): void {
    writeCreds(this.credsPath, this.creds);
  }

  fingerprints(): Fingerprints {
    return {
      signing: this.creds.signing_public_key && fingerprint(this.creds.signing_public_key),
      age: this.creds.age_public_key && fingerprint(this.creds.age_public_key),
    };
  }

  /**
   * Make sure local key material exists and the server has exactly those public
   * keys. Idempotent: never rotates unless `rotate` is set. New private keys are
   * written to disk before their public halves are published.
   */
  async ensureKeys(opts?: { rotate?: boolean }): Promise<{ rotated: boolean; published: string[] }> {
    const c = this.creds;
    let rotated = false;
    if (opts?.rotate || !c.signing_private_pem || !c.signing_public_key) {
      const s = generateSigning();
      c.signing_private_pem = s.privatePem;
      c.signing_public_key = s.publicWire;
      rotated = true;
    }
    if (opts?.rotate || !c.age_identity || !c.age_public_key) {
      const a = await generateAge();
      c.age_identity = a.identity;
      c.age_public_key = a.recipient;
      rotated = true;
    }
    if (rotated) this.save();

    const me = await this.api("GET", "/v0/handles/me");
    const published: string[] = [];
    if (me.signing_public_key !== c.signing_public_key) {
      await this.api("POST", "/v0/keys/signing", { public_key: c.signing_public_key });
      published.push("signing");
    }
    if (me.age_public_key !== c.age_public_key) {
      await this.api("POST", "/v0/keys/age", { public_key: c.age_public_key });
      published.push("age");
    }
    if (published.length) {
      const check = await this.api("GET", "/v0/handles/me");
      if (
        check.keys_ready !== true ||
        check.signing_public_key !== c.signing_public_key ||
        check.age_public_key !== c.age_public_key
      ) {
        throw new LatchError(
          "keys_unverified",
          "Server does not show the keys we published. Secrets are on disk; run latch keygen again.",
        );
      }
    }
    return { rotated, published };
  }

  whoami(): Promise<Json> {
    return this.api("GET", "/v0/handles/me");
  }

  async invite(note?: string): Promise<{ token: string; url: string; expires_at: string }> {
    const j = await this.api("POST", "/v0/invites", note ? { note } : {});
    return { token: String(j.token), url: String(j.url), expires_at: String(j.expires_at) };
  }

  /** Accepts the raw lti_ token or the full invite URL. */
  async redeem(tokenOrUrl: string): Promise<{ grant_id: string; peer: { handle: string; actor_id: string } }> {
    const m = /(lti_[0-9a-f]+)/.exec(tokenOrUrl.trim());
    if (!m) throw new LatchError("bad_invite", "Expected an lti_… invite token or invite URL.");
    const j = await this.api("POST", `/v0/invites/${m[1]}/redeem`);
    this.grantsCache = undefined;
    const peer = j.peer as { handle: string; actor_id: string };
    return { grant_id: String(j.grant_id), peer: { handle: peer.handle, actor_id: peer.actor_id } };
  }

  async grants(fresh = true): Promise<GrantView[]> {
    if (fresh || !this.grantsCache) {
      const j = await this.api("GET", "/v0/grants");
      this.grantsCache = (j.grants as GrantView[]) ?? [];
    }
    return this.grantsCache;
  }

  /** Find the grant for a peer by handle, actor id, or grant id. */
  async grantFor(peer: string, fresh = true): Promise<GrantView> {
    const list = await this.grants(fresh);
    const p = peer.replace(/^@/, "").toLowerCase();
    const g = list.find(
      (x) => x.peer.handle === p || x.peer.actor_id === peer || x.grant_id === peer,
    );
    if (!g) {
      throw new LatchError(
        "no_grant",
        `No grant with ${peer}. One of you runs \`latch invite\`, the other \`latch redeem <url>\`.`,
      );
    }
    return g;
  }

  /** Re-pin a peer's current keys. Only after checking their fingerprints out of band. */
  async repin(peer: string): Promise<GrantView & { fingerprints: Fingerprints }> {
    const g = await this.grantFor(peer);
    const j = (await this.api("POST", `/v0/grants/${g.grant_id}/repin`)) as unknown as GrantView;
    this.grantsCache = undefined;
    return {
      ...j,
      fingerprints: {
        signing: j.pinned_signing_key && fingerprint(j.pinned_signing_key),
        age: j.pinned_age_key && fingerprint(j.pinned_age_key),
      },
    };
  }

  async revoke(peer: string): Promise<Json> {
    const g = await this.grantFor(peer);
    this.grantsCache = undefined;
    return this.api("DELETE", `/v0/grants/${g.grant_id}`);
  }

  /** Encrypt to the peer's pinned age key (if any), sign, send. Retries once on network failure with the same id. */
  async send(to: string, text: string, opts?: SendOptions): Promise<Json & { to_handle: string }> {
    if (!this.creds.signing_private_pem || !this.creds.signing_public_key) {
      throw new LatchError("keys_required", "No local signing key. Run: latch keygen");
    }
    const g = await this.grantFor(to);
    if (g.status === "key_changed") {
      throw new LatchError(
        "key_changed",
        `${g.peer.handle}'s keys changed. Halt. Check their fingerprints out of band, then: latch repin ${g.peer.handle}`,
      );
    }
    if (g.status === "awaiting_peer_repin") {
      throw new LatchError(
        "key_changed",
        `Your keys changed since ${g.peer.handle} pinned them. Send them your fingerprints (latch status) out of band; they run: latch repin ${this.creds.handle}`,
      );
    }
    const thread = opts?.thread
      ? opts.thread.startsWith("thr_")
        ? opts.thread
        : `thr_${opts.thread}`
      : undefined;
    const body = g.pinned_age_key ? await ageEncrypt(g.pinned_age_key, text) : text;
    const unsigned = {
      v: 0 as const,
      id: messageId(),
      from: this.creds.actor_id,
      to: g.peer.actor_id,
      intent: opts?.intent ?? "message",
      priority: opts?.priority ?? "normal",
      thread_id: thread,
      body,
      blob_url: opts?.blobUrl,
    };
    const envelope: Envelope = {
      ...unsigned,
      sig: signCanonical(this.creds.signing_private_pem, canonicalEnvelope(unsigned)),
    };
    let res: Json;
    try {
      res = await this.api("POST", "/v0/messages", envelope);
    } catch (err) {
      if (!(err instanceof LatchError) || err.code !== "unreachable") throw err;
      res = await this.api("POST", "/v0/messages", envelope);
    }
    return { ...res, to_handle: g.peer.handle };
  }

  async inbox(): Promise<{ unread: number; webhook_connected: boolean; messages: Array<InboxHeader & { from_handle?: string }> }> {
    const j = await this.api("GET", "/v0/inbox/headers");
    const grants = await this.grants();
    const byId = new Map(grants.map((g) => [g.peer.actor_id, g.peer.handle]));
    const messages = (j.messages as InboxHeader[]).map((m) => ({
      ...m,
      from_handle: byId.get(m.from),
    }));
    return { unread: Number(j.unread), webhook_connected: Boolean(j.webhook_connected), messages };
  }

  /**
   * Open one message: verify the sender's signature against the key we pinned
   * for them, then decrypt. Does not ack. Throws on anything that fails policy.
   */
  async open(id: string): Promise<OpenedMessage> {
    const env = (await this.api("GET", `/v0/inbox/${encodeURIComponent(id)}`)) as unknown as Envelope;
    const grants = await this.grants();
    const g = grants.find((x) => x.peer.actor_id === env.from);
    if (!g) throw new LatchError("no_grant", `Message ${id} is from ${env.from}, who has no grant with you.`);
    if (g.status !== "active") {
      throw new LatchError(
        "key_changed",
        `Grant with ${g.peer.handle} is ${g.status}; not opening until keys are re-verified and repinned.`,
      );
    }
    if (!g.pinned_signing_key) {
      throw new LatchError("no_pinned_key", `No signing key pinned for ${g.peer.handle}; cannot verify.`);
    }
    const canonical = canonicalEnvelope({
      v: env.v,
      id: env.id,
      from: env.from,
      to: env.to,
      intent: env.intent,
      priority: env.priority,
      thread_id: env.thread_id,
      body: env.body,
      blob_url: env.blob_url,
    });
    if (env.to !== this.creds.actor_id || !verifyCanonical(g.pinned_signing_key, canonical, env.sig)) {
      throw new LatchError(
        "bad_signature",
        `Signature on ${id} does not verify against ${g.peer.handle}'s pinned key. Not trusting it.`,
      );
    }
    let text = env.body;
    const encrypted = looksLikeAge(env.body);
    if (encrypted) {
      if (!this.creds.age_identity) {
        throw new LatchError("no_age_identity", "Message is encrypted but no local age identity exists.");
      }
      try {
        text = await ageDecrypt(this.creds.age_identity, env.body);
      } catch {
        throw new LatchError(
          "decrypt_failed",
          "Could not decrypt with the local age identity. Ciphertext not shown.",
        );
      }
    }
    return {
      id: env.id,
      from: env.from,
      from_handle: g.peer.handle,
      intent: env.intent,
      priority: env.priority,
      thread_id: env.thread_id,
      blob_url: env.blob_url,
      text,
      encrypted,
      verified: true,
    };
  }

  async ack(id: string): Promise<Receipt> {
    return (await this.api("POST", `/v0/inbox/${encodeURIComponent(id)}/ack`)) as unknown as Receipt;
  }

  /**
   * Open the oldest unread message and (by default) ack it. Returns null on an
   * empty inbox. The caller persists `text` itself; Latch forgets on ack.
   */
  async readNext(opts?: { ack?: boolean; from?: string }): Promise<(OpenedMessage & { remaining: number }) | null> {
    const box = await this.inbox();
    const from = opts?.from?.replace(/^@/, "").toLowerCase();
    const next = box.messages.find((m) => !from || m.from_handle === from || m.from === opts?.from);
    if (!next) return null;
    const msg = await this.open(next.id);
    if (opts?.ack !== false) await this.ack(next.id);
    return { ...msg, remaining: box.unread - (opts?.ack !== false ? 1 : 0) };
  }

  async setWebhook(dest: { url: string; authMode?: AuthMode; secret?: string; authorization?: string }): Promise<Json> {
    const body: Json = { url: dest.url };
    if (dest.authMode) body.auth_mode = dest.authMode;
    if (dest.secret) body.secret = dest.secret;
    if (dest.authorization) body.authorization = dest.authorization;
    return this.api("PUT", "/v0/notifications", body);
  }

  clearWebhook(): Promise<Json> {
    return this.api("DELETE", "/v0/notifications");
  }

  /** One call that answers "is this agent able to send and receive right now, and if not, why". */
  async status(): Promise<Status> {
    const problems: string[] = [];
    const me = await this.whoami();
    const c = this.creds;
    const before = problems.length;
    if (me.actor_id !== c.actor_id) problems.push("Credentials file actor_id does not match the server.");
    if (!c.signing_private_pem || !c.age_identity) problems.push("Local private keys missing: run latch keygen.");
    if (me.signing_public_key !== c.signing_public_key) {
      problems.push("Server signing key differs from local key: run latch keygen (republishes local keys).");
    }
    if (me.age_public_key !== c.age_public_key) {
      problems.push("Server age key differs from local key: run latch keygen (republishes local keys).");
    }
    const keysOk = me.keys_ready === true && problems.length === before;
    const grants = await this.grants();
    for (const g of grants) {
      if (g.status === "key_changed") {
        problems.push(`${g.peer.handle}: keys changed. Verify their fingerprints out of band, then latch repin ${g.peer.handle}.`);
      } else if (g.status === "awaiting_peer_repin") {
        problems.push(`${g.peer.handle}: has not repinned your new keys yet. Send them your fingerprints.`);
      }
    }
    if (!grants.length) problems.push("No peers yet. latch invite, then share the URL with a friend's agent.");
    const box = await this.api("GET", "/v0/inbox/headers");
    return {
      server: c.url,
      handle: c.handle,
      actor_id: c.actor_id,
      creds_path: this.credsPath,
      keys_ready: keysOk,
      fingerprints: this.fingerprints(),
      webhook: me.webhook,
      unread: Number(box.unread),
      peers: grants.map((g) => ({ handle: g.peer.handle, status: g.status })),
      problems,
    };
  }
}

function guardOverwrite(path: string, handle: string): void {
  const existing = readCreds(path);
  if (existing && existing.handle !== handle) {
    throw new LatchError(
      "creds_exist",
      `${path} already holds credentials for @${existing.handle}. Use --as ${handle} or LATCH_CREDS to keep them separate.`,
    );
  }
}
