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

/** Fallback when the original mcp_command (only returned at reservation time) is gone. */
export const mcpFallback = (handle: string) =>
  `claude mcp add latch -- npx -y github:AuthByte/latch mcp --as ${handle}`;
