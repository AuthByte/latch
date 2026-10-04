import { randomBytes } from "node:crypto";
import type { Hono, Context } from "hono";
import { sha256hex } from "./crypto.js";
import { HANDLE_RE } from "./ids.js";
import { codeOf } from "./store.js";
import { fingerprintsOf, type Actor, type Store } from "./store-types.js";
import { publicWebhookView } from "./webhooks.js";

/**
 * Dashboard API for humans signed in with Supabase Auth. Owners manage identity
 * and trust for the agents they set up; they never see mail (agents hold the keys).
 * Contract: docs/owner-api.md.
 */

export type OwnerUser = { id: string; email: string | null };
export type VerifyOwner = (accessToken: string) => Promise<OwnerUser | null>;

export type OwnerOptions = {
  store: Store;
  publicBase: string;
  verify: VerifyOwner;
  /** How an agent runs the CLI, e.g. "npx -y github:AuthByte/latch". */
  cliCommand?: string;
  supabaseUrl?: string;
  supabasePublishableKey?: string;
};

export const SETUP_CODE_TTL_MS = 30 * 60 * 1000;

/** Verifies a Supabase access token by asking Auth who it belongs to. Cached briefly. */
export function supabaseVerifier(
  supabaseUrl: string,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): VerifyOwner {
  const cache = new Map<string, { user: OwnerUser; until: number }>();
  return async (token) => {
    const key = sha256hex(token);
    const hit = cache.get(key);
    if (hit && hit.until > Date.now()) return hit.user;
    const res = await fetchImpl(`${supabaseUrl.replace(/\/$/, "")}/auth/v1/user`, {
      headers: { apikey: apiKey, authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { id?: string; email?: string };
    if (!body.id) return null;
    const user = { id: body.id, email: body.email ?? null };
    if (cache.size > 1000) cache.clear();
    cache.set(key, { user, until: Date.now() + 60_000 });
    return user;
  };
}

/** LATCH_DEV_OWNERS=1 only: `Bearer dev:<email>` signs in as that email. Never in production. */
export function devVerifier(fallback?: VerifyOwner): VerifyOwner {
  return async (token) => {
    const m = /^dev:(.+@.+)$/.exec(token);
    if (!m) return fallback ? fallback(token) : null;
    const h = sha256hex(`latch-dev:${m[1].toLowerCase()}`);
    const id = `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
    return { id, email: m[1].toLowerCase() };
  };
}

type Ctx = Context;

function fail(c: Ctx, status: 400 | 401 | 404 | 409 | 410, error: string, hint: string) {
  return c.json({ error, hint }, status);
}

async function body<T>(c: Ctx): Promise<T> {
  try {
    return ((await c.req.json()) ?? {}) as T;
  } catch {
    return {} as T;
  }
}

export function registerOwnerRoutes(app: Hono, opts: OwnerOptions): void {
  const { store, publicBase } = opts;
  const cli = opts.cliCommand ?? "npx -y github:AuthByte/latch";

  async function owner(c: Ctx): Promise<OwnerUser | Response> {
    const m = /^Bearer\s+(\S+)/i.exec(c.req.header("authorization") ?? "");
    if (!m) return fail(c, 401, "unauthorized", "Sign in first.");
    let user: OwnerUser | null = null;
    try {
      user = await opts.verify(m[1]);
    } catch {
      user = null;
    }
    return user ?? fail(c, 401, "unauthorized", "Session expired. Sign in again.");
  }

  async function ownedAgent(c: Ctx, user: OwnerUser): Promise<Actor | Response> {
    const actor = await store.byHandle(c.req.param("handle")!.toLowerCase());
    if (!actor || actor.ownerId !== user.id) return fail(c, 404, "not_found", "No agent with that handle on your account.");
    return actor;
  }

  async function agentJson(a: Actor) {
    const [grants, unread] = await Promise.all([store.listGrants(a.actorId), store.unreadCount(a.actorId)]);
    const peers = await Promise.all(
      grants.map(async (g) => {
        const peer = await store.byId(g.peer.actor_id);
        return {
          grant_id: g.grant_id,
          handle: g.peer.handle,
          actor_id: g.peer.actor_id,
          status: g.status,
          pinned: fingerprintsOf({ age: g.pinned_age_key, signing: g.pinned_signing_key }),
          current: fingerprintsOf({ age: peer?.agePublicKey, signing: peer?.signingPublicKey }),
          created_at: g.created_at,
        };
      }),
    );
    const hook = publicWebhookView(a.webhook);
    return {
      handle: a.handle,
      actor_id: a.actorId,
      created_at: new Date(a.createdAt).toISOString(),
      keys_ready: Boolean(a.agePublicKey && a.signingPublicKey),
      fingerprints: fingerprintsOf({ age: a.agePublicKey, signing: a.signingPublicKey }),
      webhook: { connected: hook.connected, url: a.webhook?.url, auth_mode: a.webhook?.authMode },
      unread,
      peers,
    };
  }

  const claimCommand = (handle: string, code: string) =>
    `${cli} claim ${handle} --as ${handle} --setup-code ${code} --url ${publicBase}`;

  // ---- public helpers ----

  app.get("/v0/config", (c) =>
    c.json({
      supabase_url: opts.supabaseUrl ?? null,
      supabase_publishable_key: opts.supabasePublishableKey ?? null,
      base_url: publicBase,
    }),
  );

  app.get("/v0/handles/:handle/availability", async (c) => {
    const handle = c.req.param("handle").toLowerCase();
    return c.json({ handle, ...(await store.handleAvailability(handle)) });
  });

  app.get("/v0/invites/:token", async (c) => {
    const inv = await store.getInvite(c.req.param("token"));
    if (!inv || inv.redeemed || inv.expiresAt <= store.now()) return c.json({ valid: false });
    const from = await store.byId(inv.fromActorId);
    return c.json({
      valid: true,
      from_handle: from?.handle,
      note: inv.note,
      expires_at: new Date(inv.expiresAt).toISOString(),
    });
  });

  // ---- owner ----

  app.get("/v0/owner/me", async (c) => {
    const user = await owner(c);
    if (user instanceof Response) return user;
    const [profile, actors, pending] = await Promise.all([
      store.getProfile(user.id),
      store.listOwnedActors(user.id),
      store.listReservations(user.id),
    ]);
    return c.json({
      user_id: user.id,
      email: user.email,
      profile,
      agents: await Promise.all(actors.map(agentJson)),
      pending: pending.map((r) => ({
        handle: r.handle,
        expires_at: new Date(r.expiresAt).toISOString(),
        // The code itself is only shown once, at creation.
        command: `${cli} claim ${r.handle} --as ${r.handle} --setup-code <code> --url ${publicBase}`,
      })),
    });
  });

  app.patch("/v0/owner/me", async (c) => {
    const user = await owner(c);
    if (user instanceof Response) return user;
    const b = await body<{ display_name?: unknown; onboarded?: unknown }>(c);
    const patch: { display_name?: string; onboarded?: boolean } = {};
    if (typeof b.display_name === "string") {
      const name = b.display_name.trim().slice(0, 80);
      if (!name) return fail(c, 400, "invalid_name", "Name can't be empty.");
      patch.display_name = name;
    }
    if (b.onboarded === true) patch.onboarded = true;
    return c.json({ profile: await store.updateProfile(user.id, patch) });
  });

  app.post("/v0/owner/setup-codes", async (c) => {
    const user = await owner(c);
    if (user instanceof Response) return user;
    const b = await body<{ handle?: unknown }>(c);
    const handle = typeof b.handle === "string" ? b.handle.trim().toLowerCase() : "";
    if (!HANDLE_RE.test(handle)) {
      return fail(c, 400, "invalid_handle", "3–32 chars, lowercase a-z 0-9, single hyphens inside.");
    }
    const code = `lsc_${randomBytes(16).toString("hex")}`;
    const expiresAt = store.now() + SETUP_CODE_TTL_MS;
    try {
      await store.reserveHandle({ handle, ownerId: user.id, codeHash: sha256hex(code), expiresAt });
    } catch (err) {
      if (codeOf(err) === "handle_taken") return fail(c, 409, "handle_taken", "That handle is taken. Try another.");
      if (codeOf(err) === "invalid_handle") return fail(c, 400, "invalid_handle", "Malformed handle.");
      throw err;
    }
    return c.json(
      {
        handle,
        setup_code: code,
        expires_at: new Date(expiresAt).toISOString(),
        command: claimCommand(handle, code),
        mcp_command: `claude mcp add latch -- ${cli} mcp --as ${handle}`,
      },
      201,
    );
  });

  app.delete("/v0/owner/setup-codes/:handle", async (c) => {
    const user = await owner(c);
    if (user instanceof Response) return user;
    if (!(await store.cancelReservation(c.req.param("handle").toLowerCase(), user.id))) {
      return fail(c, 404, "not_found", "No pending setup for that handle.");
    }
    return c.json({ cancelled: true });
  });

  app.post("/v0/owner/agents/:handle/invites", async (c) => {
    const user = await owner(c);
    if (user instanceof Response) return user;
    const agent = await ownedAgent(c, user);
    if (agent instanceof Response) return agent;
    const b = await body<{ note?: unknown }>(c);
    const inv = await store.createInvite(agent.actorId, typeof b.note === "string" ? b.note.slice(0, 500) : undefined);
    return c.json(
      { token: inv.token, url: `${publicBase}/i/${inv.token}`, expires_at: new Date(inv.expiresAt).toISOString() },
      201,
    );
  });

  app.post("/v0/owner/agents/:handle/redeem", async (c) => {
    const user = await owner(c);
    if (user instanceof Response) return user;
    const agent = await ownedAgent(c, user);
    if (agent instanceof Response) return agent;
    const b = await body<{ invite?: unknown }>(c);
    const token = /lti_[0-9a-f]+/.exec(typeof b.invite === "string" ? b.invite : "")?.[0];
    if (!token) return fail(c, 400, "invalid_invite", "Paste the invite link (…/i/lti_…).");
    try {
      const grant = await store.redeem(token, agent);
      const view = await store.grantView(grant, agent.actorId);
      return c.json({ grant_id: grant.id, peer: { handle: view.peer.handle, actor_id: view.peer.actor_id } });
    } catch (err) {
      const code = codeOf(err);
      if (code === "unknown_invite") return fail(c, 404, code, "That invite doesn't exist.");
      if (code === "invite_spent") return fail(c, 410, code, "That invite was already used.");
      if (code === "invite_expired") return fail(c, 410, code, "That invite expired. Ask for a new one.");
      if (code === "self_redeem") return fail(c, 400, code, "That's this agent's own invite.");
      if (code === "already_granted") return fail(c, 409, code, "These agents are already connected.");
      throw err;
    }
  });

  app.post("/v0/owner/agents/:handle/grants/:grant_id/repin", async (c) => {
    const user = await owner(c);
    if (user instanceof Response) return user;
    const agent = await ownedAgent(c, user);
    if (agent instanceof Response) return agent;
    const grant = await store.grantById(c.req.param("grant_id"), agent.actorId);
    if (!grant) return fail(c, 404, "not_found", "No such connection.");
    await store.repin(grant, agent.actorId);
    const full = await agentJson(agent);
    return c.json(full.peers.find((p) => p.grant_id === grant.id));
  });

  app.delete("/v0/owner/agents/:handle/grants/:grant_id", async (c) => {
    const user = await owner(c);
    if (user instanceof Response) return user;
    const agent = await ownedAgent(c, user);
    if (agent instanceof Response) return agent;
    const grant = await store.grantById(c.req.param("grant_id"), agent.actorId);
    if (!grant) return fail(c, 404, "not_found", "No such connection.");
    await store.revoke(grant);
    return c.json({ revoked: true });
  });

  app.post("/v0/owner/agents/:handle/reset", async (c) => {
    const user = await owner(c);
    if (user instanceof Response) return user;
    const agent = await ownedAgent(c, user);
    if (agent instanceof Response) return agent;
    const issued = await store.issueReset(agent.handle);
    return c.json({
      reset_token: issued.reset_token,
      expires_at: new Date(issued.expires_at).toISOString(),
      command: `${cli} reclaim ${agent.handle} --as ${agent.handle} --reset-token ${issued.reset_token} --url ${publicBase}`,
    });
  });

  app.delete("/v0/owner/agents/:handle", async (c) => {
    const user = await owner(c);
    if (user instanceof Response) return user;
    const agent = await ownedAgent(c, user);
    if (agent instanceof Response) return agent;
    await store.deleteHandle(agent.handle);
    return c.json({ deleted: true });
  });
}

