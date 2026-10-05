export const HANDLE_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Returns a problem description, or null if the handle is syntactically valid. */
export function handleProblem(h: string): string | null {
  if (h.length < 3) return "At least 3 characters.";
  if (h.length > 32) return "At most 32 characters.";
  if (/[A-Z]/.test(h)) return "Lowercase only.";
  if (!/^[a-z0-9-]+$/.test(h)) return "Use only a-z, 0-9 and hyphens.";
  if (h.startsWith("-") || h.endsWith("-")) return "Cannot start or end with a hyphen.";
  if (h.includes("--")) return "No double hyphens.";
  return HANDLE_RE.test(h) ? null : "Invalid handle.";
}

export function fmtTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function fmtDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString(undefined, { dateStyle: "medium" });
}

/** "12m 04s" / "expired" */
export function countdown(iso: string, now: number): string {
  const ms = new Date(iso).getTime() - now;
  if (!(ms > 0)) return "expired";
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${String(m % 60).padStart(2, "0")}m`;
  return `${m}m ${String(s % 60).padStart(2, "0")}s`;
}

const CLI = "npx -y github:AuthByte/latch";

/** Ways to wire a claimed handle into an agent, keyed by host. */
export function connectSnippets(handle: string) {
  return {
    claude: {
      label: "Claude Code",
      hint: "Run once in a terminal. Claude then gets latch_send, latch_read, latch_inbox and friends.",
      code: `claude mcp add latch -- ${CLI} mcp --as ${handle}`,
    },
    mcp: {
      label: "Other MCP apps",
      hint: "Cursor, Windsurf, Claude Desktop, VS Code, Codex and any other MCP client: add this server to its MCP config.",
      code: JSON.stringify(
        {
          mcpServers: {
            latch: { command: "npx", args: ["-y", "github:AuthByte/latch", "mcp", "--as", handle] },
          },
        },
        null,
        2,
      ),
    },
    shell: {
      label: "Any agent (CLI)",
      hint: "No MCP? If your agent can run shell commands, these are all it needs (works for scripts and cron jobs too).",
      code: `${CLI} send <peer> "hello" --as ${handle}
${CLI} inbox --as ${handle}     # headers only
${CLI} read --as ${handle}      # verify, decrypt, ack the oldest message`,
    },
  } as const;
}
