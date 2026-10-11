-- Latch relay state. Lives in its own schema so the Supabase Data API never
-- exposes it; only the relay server (postgres role over the pooler) touches it.
-- RLS is on everywhere with no policies as a second lock.

create schema if not exists latch;

create table if not exists latch.actors (
  actor_id text primary key,
  handle text not null unique,
  token_hash text not null unique,
  recovery_hash text not null,
  age_public_key text,
  signing_public_key text,
  retention_enabled boolean not null default false,
  retention_ttl_seconds integer,
  webhook jsonb,
  owner_id uuid references auth.users (id) on delete set null,
  created_at timestamptz not null
);
create index if not exists actors_owner_idx on latch.actors (owner_id);

create table if not exists latch.invites (
  token text primary key,
  from_actor_id text not null references latch.actors (actor_id) on delete cascade,
  note text,
  expires_at timestamptz not null,
  redeemed boolean not null default false
);
create index if not exists invites_from_idx on latch.invites (from_actor_id);

create table if not exists latch.grants (
  id text primary key,
  a text not null references latch.actors (actor_id) on delete cascade,
  b text not null references latch.actors (actor_id) on delete cascade,
  pin_a_age text,
  pin_a_signing text,
  pin_b_age text,
  pin_b_signing text,
  created_at timestamptz not null,
  revoked boolean not null default false
);
create unique index if not exists grants_pair_live on latch.grants (a, b) where not revoked;
create index if not exists grants_b_idx on latch.grants (b);

-- Mail. Bodies are ciphertext and are nulled on ack/expiry; rows stay as receipts.
create table if not exists latch.messages (
  id text primary key,
  from_actor text not null,
  to_actor text not null,
  envelope jsonb not null,
  payload text,
  bytes integer not null,
  status text not null check (status in ('queued', 'opened', 'acked', 'expired')),
  queued_at timestamptz not null,
  expires_at timestamptz not null,
  opened_at timestamptz,
  acked_at timestamptz,
  expired_at timestamptz
);
create index if not exists messages_inbox_idx on latch.messages (to_actor, status, queued_at);
create index if not exists messages_due_idx on latch.messages (expires_at)
  where status in ('queued', 'opened');

create table if not exists latch.reset_tickets (
  token_hash text primary key,
  handle text not null,
  actor_id text not null references latch.actors (actor_id) on delete cascade,
  expires_at timestamptz not null,
  spent boolean not null default false
);
create index if not exists reset_tickets_actor_idx on latch.reset_tickets (actor_id);

-- Dashboard: a handle held for an owner until their agent claims it with the setup code.
create table if not exists latch.reservations (
  handle text primary key,
  owner_id uuid not null references auth.users (id) on delete cascade,
  code_hash text not null unique,
  expires_at timestamptz not null
);
create index if not exists reservations_owner_idx on latch.reservations (owner_id);

create table if not exists latch.profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  display_name text,
  onboarded_at timestamptz,
  created_at timestamptz not null default now()
);

-- Namespaces: a person's username; their agents are username.name.
alter table latch.profiles add column if not exists username text unique;

-- Old handles that keep resolving after an agent moved under its owner's username.
create table if not exists latch.aliases (
  handle text primary key,
  actor_id text not null references latch.actors (actor_id) on delete cascade
);
create index if not exists aliases_actor_idx on latch.aliases (actor_id);

-- People connections: two owners who agreed their (chosen) agents may talk.
-- owner_a < owner_b (ordered by the server), so a pair has one row.
create table if not exists latch.connections (
  id text primary key,
  owner_a uuid not null references auth.users (id) on delete cascade,
  owner_b uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null,
  unique (owner_a, owner_b)
);
create index if not exists connections_b_idx on latch.connections (owner_b);

create table if not exists latch.connection_invites (
  token text primary key,
  from_owner uuid not null references auth.users (id) on delete cascade,
  note text,
  expires_at timestamptz not null,
  accepted boolean not null default false
);
create index if not exists connection_invites_from_idx on latch.connection_invites (from_owner);

-- Which of my agents I share over a connection. Nothing is shared by default.
create table if not exists latch.shares (
  connection_id text not null references latch.connections (id) on delete cascade,
  actor_id text not null references latch.actors (actor_id) on delete cascade,
  primary key (connection_id, actor_id)
);
create index if not exists shares_actor_idx on latch.shares (actor_id);

alter table latch.grants add column if not exists connection_id text
  references latch.connections (id) on delete set null;
create index if not exists grants_connection_idx on latch.grants (connection_id) where connection_id is not null;

alter table latch.actors enable row level security;
alter table latch.invites enable row level security;
alter table latch.grants enable row level security;
alter table latch.messages enable row level security;
alter table latch.reset_tickets enable row level security;
alter table latch.reservations enable row level security;
alter table latch.profiles enable row level security;
alter table latch.aliases enable row level security;
alter table latch.connections enable row level security;
alter table latch.connection_invites enable row level security;
alter table latch.shares enable row level security;

revoke all on schema latch from anon, authenticated;
revoke all on all tables in schema latch from anon, authenticated;
