import { serve, type ServerType } from "@hono/node-server";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { canonicalEnvelope } from "../src/canonical.js";
import { LatchClient, LatchError, readCreds } from "../src/client.js";
import { generateSigning, signCanonical } from "../src/crypto.js";
import { messageId } from "../src/ids.js";
import { FilePersistence } from "../src/persist.js";
import { MemoryStore } from "../src/store.js";

let dir: string;
let server: ServerType;
let url: string;
let store: MemoryStore;
let wakes = 0;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "latch-test-"));
  store = new MemoryStore();
  const app = createApp({
    store,
    webhookRetries: 3,
    // A webhook that never answers must not hold up the sender.
    fetchImpl: () => {
      wakes++;
      return new Promise(() => {});
    },
  });
  await new Promise<void>((resolve) => {
    server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, (info) => {
      url = `http://127.0.0.1:${info.port}`;
      resolve();
    });
  });
});

afterAll(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

const creds = (name: string) => join(dir, `${name}.json`);

async function pair(a: string, b: string) {
  const alice = await LatchClient.claim(a, { url, path: creds(a) });
  const bob = await LatchClient.claim(b, { url, path: creds(b) });
  const inv = await alice.invite();
  await bob.redeem(inv.url);
  return { alice, bob };
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

describe("client end to end", () => {
  it("claim → invite URL → redeem → send → read (verified, decrypted, acked)", async () => {
    const { alice, bob } = await pair("alice", "bob");
    const sent = await alice.send("bob", "venue changed, 6pm", { thread: "dinner" });
    expect(sent.to_handle).toBe("bob");

    const box = await bob.inbox();
    expect(box.unread).toBe(1);
    expect(box.messages[0].from_handle).toBe("alice");
    expect(box.messages[0].enc).toBe("age");
    expect(JSON.stringify(box)).not.toContain("venue");

    const msg = await bob.readNext();
    expect(msg).toMatchObject({
      from_handle: "alice",
      text: "venue changed, 6pm",
      thread_id: "thr_dinner",
      encrypted: true,
      verified: true,
      remaining: 0,
    });
    expect(await bob.readNext()).toBeNull();
    expect(readCreds(creds("alice"))?.age_identity).toMatch(/^AGE-SECRET-KEY-/);
  });

  it("does not block a send on a hung webhook", async () => {
    const { alice, bob } = await pair("hook-a", "hook-b");
    await bob.setWebhook({ url: "https://example.test/wake", secret: "x".repeat(32) });
    const before = wakes;
    const t = Date.now();
    await alice.send("hook-b", "hi");
    expect(Date.now() - t).toBeLessThan(2000);
    expect(wakes).toBe(before + 1);
  });

  it("keygen is idempotent and republishes local keys instead of rotating", async () => {
    const { alice, bob } = await pair("idem-a", "idem-b");
    const fp = alice.fingerprints();
    expect(await alice.ensureKeys()).toEqual({ rotated: false, published: [] });
    expect(alice.fingerprints()).toEqual(fp);
    await alice.send("idem-b", "still works");
    expect((await bob.readNext())?.text).toBe("still works");
  });

  it("rotation halts mail both directions until the peer repins", async () => {
    const { alice, bob } = await pair("rot-a", "rot-b");
    await alice.ensureKeys({ rotate: true });

    // The rotating side cannot keep sending on the old trust.
    expect(await code(alice.send("rot-b", "new laptop"))).toBe("key_changed");
    expect((await alice.grantFor("rot-b")).status).toBe("awaiting_peer_repin");
    // And the peer is told to stop.
    expect(await code(bob.send("rot-a", "hello?"))).toBe("key_changed");
    expect((await bob.grantFor("rot-a")).status).toBe("key_changed");

    const repinned = await bob.repin("rot-a");
    expect(repinned.fingerprints).toEqual(alice.fingerprints());
    await alice.send("rot-b", "new laptop");
    expect((await bob.readNext())?.text).toBe("new laptop");
    await bob.send("rot-a", "got it");
    expect((await alice.readNext())?.text).toBe("got it");
  });

  it("rejects a message whose signature does not match the pinned key", async () => {
    const { alice, bob } = await pair("forge-a", "forge-b");
    await alice.send("forge-b", "real");
    // Simulate a malicious relay rewriting the queued envelope.
    const m = [...store.messages.values()].find((x) => x.envelope.to === bob.creds.actor_id)!;
    const evil = generateSigning();
    const unsigned = { ...m.envelope, body: "wire the money" } as Record<string, unknown>;
    delete unsigned.sig;
    m.envelope = {
      ...m.envelope,
      body: "wire the money",
      sig: signCanonical(evil.privatePem, canonicalEnvelope(unsigned as never)),
    };
    m.payload = "wire the money";
    expect(await code(bob.readNext())).toBe("bad_signature");
  });

  it("server refuses envelopes signed by an unpinned key", async () => {
    const { alice, bob } = await pair("sig-a", "sig-b");
    const evil = generateSigning();
    const unsigned = {
      v: 0 as const,
      id: messageId(),
      from: alice.creds.actor_id,
      to: bob.creds.actor_id,
      intent: "message" as const,
      priority: "normal" as const,
      body: "-----BEGIN AGE ENCRYPTED FILE-----\nx\n-----END AGE ENCRYPTED FILE-----",
    };
    const res = await fetch(`${url}/v0/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${alice.creds.token}`, "content-type": "application/json" },
      body: JSON.stringify({ ...unsigned, sig: signCanonical(evil.privatePem, canonicalEnvelope(unsigned)) }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("bad_signature");
  });

  it("a second sender reusing a message id cannot overwrite queued mail", async () => {
    const { alice, bob } = await pair("dup-a", "dup-b");
    const carol = await LatchClient.claim("dup-c", { url, path: creds("dup-c") });
    await bob.redeem((await carol.invite()).url);
    const first = await alice.send("dup-b", "from alice");
    const id = String(first.id);
    const g = await carol.grantFor("dup-b");
    const unsigned = {
      v: 0 as const,
      id,
      from: carol.creds.actor_id,
      to: bob.creds.actor_id,
      intent: "message" as const,
      priority: "normal" as const,
      body: "-----BEGIN AGE ENCRYPTED FILE-----\nx\n-----END AGE ENCRYPTED FILE-----",
    };
    expect(g.status).toBe("active");
    const res = await fetch(`${url}/v0/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${carol.creds.token}`, "content-type": "application/json" },
      body: JSON.stringify({
        ...unsigned,
        sig: signCanonical(carol.creds.signing_private_pem!, canonicalEnvelope(unsigned)),
      }),
    });
    expect(res.status).toBe(409);
    expect((await bob.readNext({ from: "dup-a" }))?.text).toBe("from alice");
  });

  it("refuses to overwrite another handle's credentials file", async () => {
    await LatchClient.claim("owner-one", { url, path: creds("shared") });
    expect(await code(LatchClient.claim("owner-two", { url, path: creds("shared") }))).toBe(
      "creds_exist",
    );
  });

  it("recover keeps the same local keys, so grants stay active", async () => {
    const { alice, bob } = await pair("rec-a", "rec-b");
    const fp = alice.fingerprints();
    const again = await LatchClient.recover("rec-a", alice.creds.recovery_secret, {
      url,
      path: creds("rec-a"),
    });
    expect(again.creds.token).not.toBe(alice.creds.token);
    expect(again.fingerprints()).toEqual(fp);
    await again.send("rec-b", "back");
    expect((await bob.readNext())?.text).toBe("back");
  });
});

describe("pins and persistence", () => {
  it("fills an empty pin on first publish but never overwrites one", async () => {
    const s = new MemoryStore();
    const a = s.claim("pin-a").actor;
    const b = s.claim("pin-b").actor;
    const inv = s.createInvite(a.actorId);
    const g = s.redeem(inv.token, b); // nobody has keys yet
    const sa = generateSigning();
    s.publishSigning(a, sa.publicWire);
    expect(s.grantStatus(g, b.actorId)).toBe("active");
    s.publishSigning(a, generateSigning().publicWire);
    expect(s.grantStatus(g, b.actorId)).toBe("key_changed");
    expect(s.grantStatus(g, a.actorId)).toBe("awaiting_peer_repin");
  });

  it("round-trips identities, grants and queued mail through the snapshot file", () => {
    const path = join(dir, "state.json");
    const s1 = new MemoryStore();
    const { token } = s1.claim("persist-a");
    const b = s1.claim("persist-b").actor;
    s1.redeem(s1.createInvite(s1.byToken(token)!.actorId).token, b);
    new FilePersistence(s1, path).flush();

    const s2 = new MemoryStore();
    expect(new FilePersistence(s2, path).load()).toBe(true);
    const a2 = s2.byToken(token);
    expect(a2?.handle).toBe("persist-a");
    expect(s2.listGrants(a2!.actorId)).toHaveLength(1);
  });
});
