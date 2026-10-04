// Typed client for the Latch owner API (docs/owner-api.md). Same-origin under /v0.

export type Fingerprints = { signing?: string; age?: string };

export type PeerStatus = "active" | "key_changed" | "awaiting_peer_repin";

export type Peer = {
  grant_id: string;
  handle: string;
  actor_id: string;
  status: PeerStatus;
  pinned: Fingerprints;
  current: Fingerprints;
  created_at: string;
};

export type Webhook = {
  connected: boolean;
  url?: string;
  auth_mode?: "hmac" | "authorization" | "both";
};

export type Agent = {
  handle: string;
  actor_id: string;
  created_at: string;
  keys_ready: boolean;
  fingerprints: Fingerprints;
  webhook: Webhook;
  unread: number;
  peers: Peer[];
};

export type Pending = { handle: string; expires_at: string; command: string };
export type Profile = { display_name: string | null; onboarded_at: string | null };

export type Me = {
  user_id: string;
  email: string;
  profile: Profile;
  agents: Agent[];
  pending: Pending[];
};

export type SetupCode = {
  handle: string;
  setup_code: string;
  expires_at: string;
  command: string;
  mcp_command: string;
};

export type InviteMint = { token: string; url: string; expires_at: string };
export type RedeemResult = { grant_id: string; peer: { handle: string; actor_id: string } };
export type ResetResult = { reset_token: string; expires_at: string; command: string };
export type Availability = {
  handle: string;
  available: boolean;
  reason?: "invalid" | "taken" | "reserved";
};
export type InvitePreview = {
  valid: boolean;
  from_handle?: string;
  note?: string;
  expires_at?: string;
};
export type PublicConfig = {
  supabase_url: string;
  supabase_publishable_key: string;
  base_url: string;
};

export class ApiError extends Error {
  status: number;
  code: string;
  hint: string;
  constructor(status: number, code: string, hint: string) {
    super(hint || code);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.hint = hint;
  }
}

/** Returns the bearer token for the current session, or null when signed out. */
type TokenGetter = () => Promise<string | null>;
let getToken: TokenGetter = async () => null;
export function setTokenGetter(fn: TokenGetter): void {
  getToken = fn;
}

async function request<T>(
  method: string,
  path: string,
  opts: { body?: unknown; auth?: boolean; signal?: AbortSignal } = {},
): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (opts.auth !== false) {
    const token = await getToken();
    if (!token) throw new ApiError(401, "unauthorized", "You are signed out. Sign in again.");
    headers.Authorization = `Bearer ${token}`;
  }
  let body: string | undefined;
  if (opts.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(opts.body);
  }
  let res: Response;
  try {
    res = await fetch(path, { method, headers, body, signal: opts.signal });
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") throw e;
    throw new ApiError(0, "network_error", "Could not reach the Latch server. Check your connection and try again.");
  }
  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  if (!res.ok) {
    const d = (data ?? {}) as { error?: string; hint?: string };
    throw new ApiError(res.status, d.error ?? `http_${res.status}`, d.hint ?? defaultHint(res.status));
  }
  return data as T;
}

function defaultHint(status: number): string {
  if (status === 401) return "Your session expired. Sign in again.";
  if (status === 404) return "Not found.";
  if (status >= 500) return "The server hit an error. Try again in a moment.";
  return `Request failed (${status}).`;
}

const enc = encodeURIComponent;
const agentPath = (h: string) => `/v0/owner/agents/${enc(h)}`;

// ---- public ----
export const getConfig = () => request<PublicConfig>("GET", "/v0/config", { auth: false });
export const checkHandle = (handle: string, signal?: AbortSignal) =>
  request<Availability>("GET", `/v0/handles/${enc(handle)}/availability`, { auth: false, signal });
export const previewInvite = (token: string) =>
  request<InvitePreview>("GET", `/v0/invites/${enc(token)}`, { auth: false });

// ---- owner ----
export const getMe = (signal?: AbortSignal) => request<Me>("GET", "/v0/owner/me", { signal });
export const patchMe = (body: { display_name?: string; onboarded?: true }) =>
  request<{ profile: Profile }>("PATCH", "/v0/owner/me", { body });
export const createSetupCode = (handle: string) =>
  request<SetupCode>("POST", "/v0/owner/setup-codes", { body: { handle } });
export const cancelSetupCode = (handle: string) =>
  request<{ cancelled: true }>("DELETE", `/v0/owner/setup-codes/${enc(handle)}`);
export const createInvite = (handle: string, note?: string) =>
  request<InviteMint>("POST", `${agentPath(handle)}/invites`, { body: note ? { note } : {} });
export const redeemInvite = (handle: string, invite: string) =>
  request<RedeemResult>("POST", `${agentPath(handle)}/redeem`, { body: { invite } });
export const repinGrant = (handle: string, grantId: string) =>
  request<Peer>("POST", `${agentPath(handle)}/grants/${enc(grantId)}/repin`);
export const revokeGrant = (handle: string, grantId: string) =>
  request<{ revoked: true }>("DELETE", `${agentPath(handle)}/grants/${enc(grantId)}`);
export const resetAgent = (handle: string) =>
  request<ResetResult>("POST", `${agentPath(handle)}/reset`);
export const deleteAgent = (handle: string) =>
  request<{ deleted: true }>("DELETE", agentPath(handle));

// ---- helpers ----
export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) return e.hint;
  if (e instanceof Error) return e.message;
  return "Something went wrong.";
}

/** Accepts a full invite URL or a bare lti_ token and returns the token. */
export function inviteTokenFrom(input: string): string | null {
  const s = input.trim();
  if (!s) return null;
  const m = s.match(/\/i\/([A-Za-z0-9_-]+)/) ?? s.match(/\b(lti_[A-Za-z0-9_-]+)/);
  return m ? m[1] : null;
}
