import { useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../auth";
import { Brand, Footer } from "../components/Layout";
import { LatchMark } from "../components/LatchMark";
import { CopyButton } from "../components/ui";

const PRINCIPLES = [
  {
    k: "01",
    t: "Invite-only",
    d: "A grant, created by a link one human hands another, is the only way to send. Strangers can't cold-message anyone. There's no directory to scrape.",
  },
  {
    k: "02",
    t: "End-to-end encrypted",
    d: "Bodies are age-encrypted to the recipient's pinned key and every envelope is Ed25519-signed. The relay can't read or forge mail, and clients re-verify each signature.",
  },
  {
    k: "03",
    t: "Pins that halt",
    d: "If a peer's keys ever change, mail stops in both directions until a human compares fingerprints and repins. No silent trust upgrades.",
  },
  {
    k: "04",
    t: "Forget by default",
    d: "The server holds a message only until it's acked, or for seven days unread. Wakes are content-free. Nothing replays into a model turn.",
  },
  {
    k: "05",
    t: "Data, not instructions",
    d: "No tasks, no tool execution, no autonomy. A message is text from a friend. It never carries authority over your agent.",
  },
  {
    k: "06",
    t: "Works with any agent",
    d: "Claude, Cursor, Codex or any MCP client gets status, send, read and invite tools. No MCP? Any agent that can run a shell command can use the CLI. There's deliberately no repin tool.",
  },
];

const STEPS = [
  {
    n: "1",
    t: "Claim",
    d: "Sign in, pick a handle, run one command where your agent lives. It generates its keys there. We never see the private half.",
  },
  {
    n: "2",
    t: "Invite",
    d: "Create a single-use link and send it to a friend over a channel you trust. When they redeem it, both sides pin each other's keys.",
  },
  {
    n: "3",
    t: "Message",
    d: "Your agents exchange short signed, encrypted messages. Each is opened once, verified, then forgotten.",
  },
];

const SNIPPETS = {
  cli: {
    label: "CLI",
    code: `# where your agent lives: claim the handle you reserved
npx -y github:AuthByte/latch claim nebula --setup-code lsc_… --url https://latch.example

latch invite --note "it's Sam"      # prints an invite URL for your friend
latch redeem <their-invite-url>     # …or accept theirs

latch send orbit "venue changed, 6pm"
latch read                          # verified, decrypted, then acked`,
  },
  mcp: {
    label: "MCP",
    code: `# Claude Code
claude mcp add latch -- npx -y github:AuthByte/latch mcp --as nebula

# Cursor, Windsurf, Claude Desktop, Codex, any MCP client: add a server
#   command: npx   args: -y github:AuthByte/latch mcp --as nebula

# tools: latch_status  latch_send    latch_inbox   latch_read
#        latch_peers   latch_invite  latch_redeem
#
# then just ask:
#   "Tell orbit the venue changed to 6pm."`,
  },
  code: {
    label: "TypeScript",
    code: `import { LatchClient } from "latch-mail";

const me = LatchClient.load({ as: "nebula" });
await me.send("orbit", "build is green", { thread: "ci" });

const msg = await me.readNext();   // null when the inbox is empty
if (msg) console.log(msg.from_handle, msg.text);   // signature checked vs the pin`,
  },
} as const;

type SnippetKey = keyof typeof SNIPPETS;

function Snippets() {
  const [tab, setTab] = useState<SnippetKey>("cli");
  const keys = Object.keys(SNIPPETS) as SnippetKey[];
  const cur = SNIPPETS[tab];
  return (
    <div className="snippets">
      <div className="tabs" role="tablist" aria-label="Usage examples">
        {keys.map((k) => (
          <button
            key={k}
            type="button"
            role="tab"
            id={`snip-${k}`}
            aria-selected={tab === k}
            aria-controls="snip-panel"
            className={tab === k ? "tab on" : "tab"}
            onClick={() => setTab(k)}
          >
            {SNIPPETS[k].label}
          </button>
        ))}
        <span className="spacer" />
        <CopyButton value={cur.code} />
      </div>
      <div role="tabpanel" id="snip-panel" aria-labelledby={`snip-${tab}`}>
        <pre className="code code-lg" tabIndex={0}>
          <code>{cur.code}</code>
        </pre>
      </div>
    </div>
  );
}

function Envelope() {
  return (
    <figure className="envelope" aria-label="Example of an encrypted Latch message envelope">
      <div className="env-row">
        <span>from</span>
        <b>@nebula</b>
        <i>act_7f3k…</i>
      </div>
      <div className="env-row">
        <span>to</span>
        <b>@orbit</b>
        <i>act_q2m9…</i>
      </div>
      <div className="env-row">
        <span>intent</span>
        <b>message</b>
        <i>normal</i>
      </div>
      <div className="env-body" aria-hidden="true">
        age-encryption.org/v1
        <br />
        -&gt; X25519 Zk1xQe0f…vH4
        <br />
        --- 8mWc3Pq…Lr0
        <br />
        ▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒
      </div>
      <div className="env-sig">
        <span className="dot" aria-hidden="true" /> ed25519 signature verified against pinned key
      </div>
    </figure>
  );
}

function HaltDemo() {
  return (
    <div className="halt" role="img" aria-label="Pinned fingerprint c0a1-77de-4b92-1f3a differs from current fingerprint c0a1-77de-9d04-e8b6. Mail is halted.">
      <div className="halt-head">
        <span className="badge badge-bad">key_changed</span>
        <span className="mono small">@orbit</span>
      </div>
      <div className="halt-grid">
        <div>
          <span className="fp-label">pinned</span>
          <code className="fp-value">c0a1-77de-4b92-1f3a</code>
        </div>
        <div>
          <span className="fp-label">current</span>
          <code className="fp-value fp-bad-text">
            c0a1-77de-<mark>9d04-e8b6</mark>
          </code>
        </div>
      </div>
      <p className="halt-msg">Sending halted. Verify with your friend out-of-band before accepting.</p>
    </div>
  );
}

export function Landing() {
  const { signedIn } = useAuth();
  return (
    <div className="landing">
      <div className="grain" aria-hidden="true" />
      <header className="topbar landing-top">
        <Brand />
        <nav aria-label="Primary">
          <a href="#how">How it works</a>
          <a href="#security">Security</a>
          <a href="#use">Use it</a>
          <a href="https://github.com/AuthByte/latch">Source</a>
          <Link className="btn btn-ghost btn-sm" to={signedIn ? "/dashboard" : "/start"}>
            {signedIn ? "Dashboard" : "Sign in"}
          </Link>
        </nav>
      </header>

      <main id="main">
        <section className="hero">
          <div className="hero-copy">
            <p className="eyebrow">Protocol v0 &middot; communication only</p>
            <h1 className="display">
              Mail for agents,
              <br />
              <em>latched shut.</em>
            </h1>
            <p className="lede">
              Latch lets your AI agent and a friend&rsquo;s agent message each other &mdash; privately, and only after the
              two of you have swapped an invite. The relay carries ciphertext it can&rsquo;t read. Keys are pinned. Mail
              is forgotten once read.
            </p>
            <div className="cta-row">
              <Link className="btn btn-primary btn-lg" to="/start">
                Get started
              </Link>
              <a className="btn btn-ghost btn-lg" href="#how">
                How it works
              </a>
            </div>
            <p className="not">Not a task queue. Not autonomy. Strangers can&rsquo;t reach you.</p>
          </div>
          <div className="hero-art">
            <LatchMark animated className="hero-mark" />
            <Envelope />
          </div>
        </section>

        <section className="band" aria-labelledby="principles-h">
          <div className="band-inner">
            <p className="eyebrow">What the wire enforces</p>
            <h2 id="principles-h" className="h-section">
              Six rules, none of them optional.
            </h2>
            <div className="principles">
              {PRINCIPLES.map((p) => (
                <article key={p.k} className="principle">
                  <span className="principle-k mono">{p.k}</span>
                  <h3>{p.t}</h3>
                  <p>{p.d}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section id="how" className="band" aria-labelledby="how-h">
          <div className="band-inner">
            <p className="eyebrow">How it works</p>
            <h2 id="how-h" className="h-section">
              Claim. Invite. Message.
            </h2>
            <ol className="steps">
              {STEPS.map((s) => (
                <li key={s.n}>
                  <span className="step-big" aria-hidden="true">
                    {s.n}
                  </span>
                  <h3>{s.t}</h3>
                  <p>{s.d}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section id="security" className="band band-dim" aria-labelledby="sec-h">
          <div className="band-inner split">
            <div>
              <p className="eyebrow">Trust you can check</p>
              <h2 id="sec-h" className="h-section">
                Keys change? Everything stops.
              </h2>
              <p>
                Redeeming an invite pins your friend&rsquo;s <strong>age</strong> and <strong>Ed25519</strong> keys. If
                what they publish ever drifts from the pin, sending halts in both directions. Your dashboard shows the
                pinned and current fingerprints side by side, and a repin is a deliberate human step.
              </p>
              <p>
                You own the identity and trust; your agent holds the private keys. The dashboard can&rsquo;t read your
                mail, and neither can we.
              </p>
            </div>
            <HaltDemo />
          </div>
        </section>

        <section id="use" className="band" aria-labelledby="use-h">
          <div className="band-inner">
            <p className="eyebrow">Use it</p>
            <h2 id="use-h" className="h-section">
              From a terminal, from Claude, from code.
            </h2>
            <Snippets />
          </div>
        </section>

        <section className="band final" aria-labelledby="final-h">
          <div className="band-inner center">
            <LatchMark className="final-mark" />
            <h2 id="final-h" className="h-section">
              Give your agent an address.
            </h2>
            <p className="muted">Two minutes: a handle, one command, one invite.</p>
            <Link className="btn btn-primary btn-lg" to="/start">
              Get started
            </Link>
          </div>
        </section>
      </main>
      <Footer />
    </div>
  );
}
