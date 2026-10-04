import { serve, type ServerType } from "@hono/node-server";
import { PGlite } from "@electric-sql/pglite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { LatchClient, LatchError } from "../src/client.js";
import { devVerifier } from "../src/owner.js";
import { PgStore, pgliteDb } from "../src/pg-store.js";
import { MemoryStore } from "../src/store.js";
import type { Store } from "../src/store-types.js";

/**
 * The same flows against PgStore (PGlite, real Postgres semantics) and the
 * owner/dashboard API against both stores.
 */

async function pgStore(): Promise<{ store: PgStore; pg: PGlite }> {
  const pg = new PGlite();
  await pg.exec(`
    create role anon; create role authenticated;
    create schema auth;
    create table auth.users (id uuid primary key, email text);
  `);
  await pg.exec(readFileSync(new URL("../db/schema.sql", import.meta.url), "utf8"));
  return { store: new PgStore(pgliteDb(pg as never)), pg };
}

async function boot(store: Store | MemoryStore) {
  const app = createApp({
    store,
    awaitWebhooks: true,
    webhookRetries: 1,
    owner: { verify: devVerifier() },
  });
  return new Promise<{ server: ServerType; url: string }>((resolve) => {
    const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, (info) =>
      resolve({ server, url: `http://127.0.0.1:${info.port}` }),
    );
  });
}

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    if (err instanceof LatchError) return err.code;
    throw err;
  }
  return "ok";
}

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "latch-pg-"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("PgStore protocol", () => {
  let server: ServerType;
  let url: string;
  const creds = (n: string) => join(dir, `pg-${n}.json`);

  beforeAll(async () => {
    const { store } = await pgStore();
    ({ server, url } = await boot(store));
  });
  afterAll(() => server.close());

  async function pair(a: string, b: string) {
    const alice = await LatchClient.claim(a, { url, path: creds(a) });
    const bob = await LatchClient.claim(b, { url, path: creds(b) });
    await bob.redeem((await alice.invite()).url);
    return { alice, bob };
  }

  it("claim → invite → redeem → send → read → ack", async () => {
    const { alice, bob } = await pair("alice", "bob");
    await alice.send("bob", "hello from postgres", { thread: "t1" });
    expect((await bob.inbox()).unread).toBe(1);
    const msg = await bob.readNext();
    expect(msg).toMatchObject({ text: "hello from postgres", verified: true, from_handle: "alice" });
    expect((await bob.inbox()).unread).toBe(0);
    expect(await code(LatchClient.claim("alice", { url, path: creds("alice2") }))).toBe("handle_taken");
  });

  it("idempotent replay and id reuse", async () => {
    const { alice, bob } = await pair("idem-a", "idem-b");
    await alice.send("idem-b", "once");
    await alice.send("idem-b", "twice");
    expect((await bob.inbox()).unread).toBe(2);
  });

  it("rotation blocks both ways until repin", async () => {
    const { alice, bob } = await pair("rot-a", "rot-b");
    await alice.ensureKeys({ rotate: true });
    expect(await code(alice.send("rot-b", "x"))).toBe("key_changed");
    expect((await bob.grantFor("rot-a")).status).toBe("key_changed");
    await bob.repin("rot-a");
    await alice.send("rot-b", "after repin");
    expect((await bob.readNext())?.text).toBe("after repin");
  });

  it("recover keeps keys; redeeming twice is refused", async () => {
    const { alice, bob } = await pair("rec-a", "rec-b");
    const again = await LatchClient.recover("rec-a", alice.creds.recovery_secret, { url, path: creds("rec-a") });
    await again.send("rec-b", "back");
    expect((await bob.readNext())?.text).toBe("back");
    expect(await code(again.redeem((await bob.invite()).url))).toBe("already_granted");
  });
});

for (const kind of ["memory", "postgres"] as const) {
  describe(`owner API (${kind})`, () => {
    let server: ServerType;
    let url: string;
    let pg: PGlite | undefined;
    const creds = (n: string) => join(dir, `${kind}-own-${n}.json`);
    const as = (email: string) => ({ authorization: `Bearer dev:${email}`, "content-type": "application/json" });

    beforeAll(async () => {
      if (kind === "postgres") {
        const made = await pgStore();
        pg = made.pg;
        ({ server, url } = await boot(made.store));
      } else {
        ({ server, url } = await boot(new MemoryStore()));
      }
    });
    afterAll(() => server.close());

    async function api(method: string, path: string, email: string, body?: unknown) {
      const res = await fetch(`${url}${path}`, {
        method,
        headers: as(email),
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: res.status, json: (await res.json()) as any }; // eslint-disable-line @typescript-eslint/no-explicit-any
    }

    async function signUp(email: string): Promise<string> {
      const me = await api("GET", "/v0/owner/me", email);
      expect(me.status).toBe(200);
      // In production Supabase Auth owns auth.users; mirror the row for FKs here.
      await pg?.query(`insert into auth.users (id, email) values ($1, $2) on conflict do nothing`, [
        me.json.user_id,
        email,
      ]);
      return me.json.user_id;
    }

    it("rejects missing or bad sessions", async () => {
      expect((await fetch(`${url}/v0/owner/me`)).status).toBe(401);
      expect((await fetch(`${url}/v0/owner/me`, { headers: { authorization: "Bearer nope" } })).status).toBe(401);
    });

    it("onboarding: profile, setup code, agent claims, invite + redeem, repin, revoke", async () => {
      await signUp("ann@example.com");
      await signUp("ben@example.com");

      const patched = await api("PATCH", "/v0/owner/me", "ann@example.com", { display_name: "Ann" });
      expect(patched.json.profile.display_name).toBe("Ann");

      const avail = await (await fetch(`${url}/v0/handles/ann-bot/availability`)).json();
      expect(avail).toMatchObject({ available: true });

      const setup = await api("POST", "/v0/owner/setup-codes", "ann@example.com", { handle: "ann-bot" });
      expect(setup.status).toBe(201);
      expect(setup.json.setup_code).toMatch(/^lsc_/);
      expect(setup.json.command).toContain("--setup-code");
      expect((await (await fetch(`${url}/v0/handles/ann-bot/availability`)).json()).reason).toBe("reserved");

      // Someone else can't take a reserved handle, with or without a code.
      expect((await api("POST", "/v0/owner/setup-codes", "ben@example.com", { handle: "ann-bot" })).status).toBe(409);
      expect(await code(LatchClient.claim("ann-bot", { url, path: creds("x1") }))).toBe("handle_reserved");
      expect(
        await code(LatchClient.claim("ann-bot", { url, path: creds("x2"), setupCode: "lsc_wrong" })),
      ).toBe("bad_setup_code");

      const annBot = await LatchClient.claim("ann-bot", { url, path: creds("ann-bot"), setupCode: setup.json.setup_code });
      let me = await api("GET", "/v0/owner/me", "ann@example.com");
      expect(me.json.pending).toHaveLength(0);
      expect(me.json.agents).toHaveLength(1);
      expect(me.json.agents[0]).toMatchObject({ handle: "ann-bot", keys_ready: true, unread: 0, peers: [] });
      expect(me.json.agents[0].fingerprints).toEqual(annBot.fingerprints());

      // Ben's agent, then the humans connect them from the dashboard.
      const benSetup = await api("POST", "/v0/owner/setup-codes", "ben@example.com", { handle: "ben-bot" });
      const benBot = await LatchClient.claim("ben-bot", { url, path: creds("ben-bot"), setupCode: benSetup.json.setup_code });
      const inv = await api("POST", "/v0/owner/agents/ann-bot/invites", "ann@example.com", { note: "hi ben" });
      expect(inv.status).toBe(201);
      const info = await (await fetch(`${url}/v0/invites/${inv.json.token}`)).json();
      expect(info).toMatchObject({ valid: true, from_handle: "ann-bot", note: "hi ben" });

      // Owners can't act on agents they don't own.
      expect((await api("POST", "/v0/owner/agents/ann-bot/redeem", "ben@example.com", { invite: inv.json.url })).status).toBe(404);
      const red = await api("POST", "/v0/owner/agents/ben-bot/redeem", "ben@example.com", { invite: inv.json.url });
      expect(red.status).toBe(200);
      expect(red.json.peer.handle).toBe("ann-bot");

      await annBot.send("ben-bot", "connected via dashboard");
      me = await api("GET", "/v0/owner/me", "ben@example.com");
      expect(me.json.agents[0].unread).toBe(1);
      expect(JSON.stringify(me.json)).not.toContain("connected via dashboard");
      expect((await benBot.readNext())?.text).toBe("connected via dashboard");

      // Rotation shows up as key_changed; the owner repins after checking fingerprints.
      await annBot.ensureKeys({ rotate: true });
      me = await api("GET", "/v0/owner/me", "ben@example.com");
      const peer = me.json.agents[0].peers[0];
      expect(peer.status).toBe("key_changed");
      expect(peer.current).toEqual(annBot.fingerprints());
      const rep = await api("POST", `/v0/owner/agents/ben-bot/grants/${peer.grant_id}/repin`, "ben@example.com");
      expect(rep.json.status).toBe("active");
      await annBot.send("ben-bot", "new keys");
      expect((await benBot.readNext())?.text).toBe("new keys");

      const rev = await api("DELETE", `/v0/owner/agents/ben-bot/grants/${peer.grant_id}`, "ben@example.com");
      expect(rev.json.revoked).toBe(true);
      expect(await code(annBot.send("ben-bot", "gone"))).toBe("no_grant");

      const done = await api("PATCH", "/v0/owner/me", "ann@example.com", { onboarded: true });
      expect(done.json.profile.onboarded_at).toBeTruthy();
    });

    it("reset and delete", async () => {
      await signUp("cy@example.com");
      const setup = await api("POST", "/v0/owner/setup-codes", "cy@example.com", { handle: "cy-bot" });
      const cy = await LatchClient.claim("cy-bot", { url, path: creds("cy-bot"), setupCode: setup.json.setup_code });
      const reset = await api("POST", "/v0/owner/agents/cy-bot/reset", "cy@example.com");
      expect(reset.json.reset_token).toMatch(/^lrt_/);
      const again = await LatchClient.reclaim("cy-bot", reset.json.reset_token, { url, path: creds("cy-bot") });
      expect(again.creds.token).not.toBe(cy.creds.token);

      const cancel = await api("POST", "/v0/owner/setup-codes", "cy@example.com", { handle: "cy-two" });
      expect(cancel.status).toBe(201);
      expect((await api("DELETE", "/v0/owner/setup-codes/cy-two", "cy@example.com")).json.cancelled).toBe(true);

      expect((await api("DELETE", "/v0/owner/agents/cy-bot", "cy@example.com")).json.deleted).toBe(true);
      expect((await api("GET", "/v0/owner/me", "cy@example.com")).json.agents).toHaveLength(0);
    });
  });
}
