#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { LatchClient, LatchError } from "./client.js";
import { isAuthMode, isIntent, isPriority, type AuthMode } from "./types.js";

type Flags = Record<string, string | boolean>;

const BOOLEAN_FLAGS = new Set(["keep", "rotate", "help", "h"]);

function parseArgs(argv: string[]): { cmd: string; pos: string[]; flags: Flags } {
  const [cmd = "help", ...rest] = argv;
  const pos: string[] = [];
  const flags: Flags = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--") {
      pos.push(...rest.slice(i + 1));
      break;
    }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > 0) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
        continue;
      }
      const name = a.slice(2);
      const next = rest[i + 1];
      if (BOOLEAN_FLAGS.has(name) || next === undefined || next.startsWith("--")) flags[name] = true;
      else {
        flags[name] = next;
        i++;
      }
    } else pos.push(a);
  }
  return { cmd, pos, flags };
}

function str(flags: Flags, name: string): string | undefined {
  const v = flags[name];
  return typeof v === "string" ? v : undefined;
}

function out(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

class Usage extends Error {}

function need<T>(v: T | undefined | "", usage: string): T {
  if (v === undefined || v === "") throw new Usage(usage);
  return v;
}

function webhookFlags(flags: Flags, url: string) {
  const mode = str(flags, "auth-mode");
  if (mode !== undefined && !isAuthMode(mode)) throw new Usage("--auth-mode is hmac|authorization|both");
  return {
    url,
    authMode: mode as AuthMode | undefined,
    secret: str(flags, "secret"),
    authorization: str(flags, "authorization"),
  };
}

const HELP = `Latch v0 — grant-latched agent mail (communication only)

Setup
  latch claim <handle>                Claim a handle, store secrets, publish keys
  latch join <handle> [--webhook-url URL --auth-mode hmac|authorization|both
                       --secret S --authorization "Bearer …"] [--join-code C]
  latch recover <handle> --secret lrs_…
  latch reclaim <handle> --reset-token lrt_…
  latch keygen [--rotate]             Republish local keys (or rotate them)
  latch status                        Is everything working? Keys, peers, inbox

Peers
  latch invite [--note TEXT]          Mint a single-use invite URL
  latch redeem <url|token>            Accept an invite (mutual grant, no auto-mail)
  latch grants                        Peers and their key status
  latch repin <peer>                  Accept a peer's new keys (verify out of band first!)
  latch revoke <peer>                 End the grant both ways

Mail
  latch send <peer> <text…>           Sign + encrypt + send ("-" reads stdin)
       [--thread NAME] [--priority low|normal|high] [--intent message|status]
  latch inbox                         Headers only, no bodies
  latch read [--from PEER] [--keep]   Open the oldest message, verify, decrypt, ack
  latch open <id>                     Open one message without acking
  latch ack <id>                      Delete the payload, print receipt

Wakes
  latch notify <url> --auth-mode … [--secret S] [--authorization HEADER]
  latch notify-clear

  latch mcp                           Run as an MCP server over stdio

Global: --as <handle> (profile at ~/.latch/<handle>.json)  --creds PATH  --url URL
Env:    LATCH_URL  LATCH_CREDS  LATCH_AS
Never paste tokens, recovery secrets, or Authorization headers into chat.
`;

async function main(): Promise<void> {
  const { cmd, pos, flags } = parseArgs(process.argv.slice(2));
  const where = { path: str(flags, "creds"), as: str(flags, "as"), url: str(flags, "url") };

  if (cmd === "help" || cmd === "-h" || cmd === "--help" || flags.help) {
    console.log(HELP);
    return;
  }

  if (cmd === "mcp") {
    const { runMcp } = await import("./mcp.js");
    await runMcp(where);
    return;
  }

  const registered = (client: LatchClient, extra?: Record<string, unknown>) =>
    out({
      handle: client.creds.handle,
      actor_id: client.creds.actor_id,
      creds: client.credsPath,
      keys_ready: true,
      fingerprints: client.fingerprints(),
      ...extra,
      next: "latch invite  (or latch redeem <url> if someone sent you one)",
      warning: "Token, recovery secret and private keys are stored locally. Do not paste them into chat.",
    });

  switch (cmd) {
    case "claim": {
      const handle = need(pos[0], "usage: latch claim <handle>");
      registered(await LatchClient.claim(handle, where));
      return;
    }
    case "join": {
      const handle = need(pos[0], "usage: latch join <handle> [--webhook-url URL …]");
      const hook = str(flags, "webhook-url");
      const { client, webhook } = await LatchClient.join(handle, {
        ...where,
        joinCode: str(flags, "join-code"),
        webhook: hook ? webhookFlags(flags, hook) : undefined,
      });
      registered(client, { webhook });
      return;
    }
    case "recover": {
      const handle = need(pos[0], "usage: latch recover <handle> --secret lrs_…");
      const secret = need(str(flags, "secret"), "usage: latch recover <handle> --secret lrs_…");
      registered(await LatchClient.recover(handle, secret, where));
      return;
    }
    case "reclaim": {
      const usage = "usage: latch reclaim <handle> --reset-token lrt_…";
      const client = await LatchClient.reclaim(
        need(pos[0], usage),
        need(str(flags, "reset-token"), usage),
        where,
      );
      registered(client, { webhook_cleared: true });
      return;
    }
  }

  const client = LatchClient.load(where);

  switch (cmd) {
    case "keygen": {
      const r = await client.ensureKeys({ rotate: flags.rotate === true });
      out({
        ...r,
        fingerprints: client.fingerprints(),
        note: r.rotated
          ? "New keys. Every peer must check these fingerprints out of band and run latch repin."
          : r.published.length
            ? "Republished your existing local keys."
            : "Keys already published and matching. Nothing to do.",
      });
      return;
    }
    case "whoami":
      out(await client.whoami());
      return;
    case "status":
    case "doctor":
      out(await client.status());
      return;
    case "fingerprint":
      out({ handle: client.creds.handle, ...client.fingerprints() });
      return;
    case "invite": {
      const inv = await client.invite(str(flags, "note"));
      out({ ...inv, share: `Send this to the other human: ${inv.url}  (they run: latch redeem ${inv.url})` });
      return;
    }
    case "redeem":
      out(await client.redeem(need(pos[0], "usage: latch redeem <invite-url|lti_token>")));
      return;
    case "grants":
    case "peers":
      out({ grants: await client.grants() });
      return;
    case "repin":
      out(await client.repin(need(pos[0], "usage: latch repin <peer>")));
      return;
    case "revoke":
      out(await client.revoke(need(pos[0], "usage: latch revoke <peer>")));
      return;
    case "send": {
      const usage = 'usage: latch send <peer> <text…>   (or --body TEXT, or "-" for stdin)';
      const to = need(pos[0], usage);
      let text = str(flags, "body") ?? pos.slice(1).join(" ");
      if (text === "-") text = readFileSync(0, "utf8").replace(/\n$/, "");
      need(text, usage);
      const intent = str(flags, "intent");
      const priority = str(flags, "priority");
      if (intent !== undefined && !isIntent(intent)) throw new Usage("--intent is message|status");
      if (priority !== undefined && !isPriority(priority)) throw new Usage("--priority is low|normal|high");
      out(
        await client.send(to, text, {
          intent,
          priority,
          thread: str(flags, "thread"),
          blobUrl: str(flags, "blob-url"),
        }),
      );
      return;
    }
    case "inbox":
      out(await client.inbox());
      return;
    case "read": {
      const msg = await client.readNext({ ack: flags.keep !== true, from: str(flags, "from") });
      out(msg ?? { empty: true });
      return;
    }
    case "open":
      out(await client.open(need(pos[0], "usage: latch open <id>")));
      return;
    case "ack":
      out(await client.ack(need(pos[0], "usage: latch ack <id>")));
      return;
    case "notify": {
      const url = need(pos[0], "usage: latch notify <url> --auth-mode hmac|authorization|both [--secret S] [--authorization HEADER]");
      out(await client.setWebhook(webhookFlags(flags, url)));
      return;
    }
    case "notify-clear":
      out(await client.clearWebhook());
      return;
    default:
      throw new Usage(`Unknown command: ${cmd}\n\n${HELP}`);
  }
}

main().catch((err) => {
  if (err instanceof Usage) {
    console.error(err.message);
    process.exit(2);
  }
  if (err instanceof LatchError) {
    console.error(JSON.stringify({ error: err.code, hint: err.message }, null, 2));
    process.exit(1);
  }
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
