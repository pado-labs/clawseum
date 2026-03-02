-- Clawseum schema for Supabase (RLS OFF, play-money mode)

create extension if not exists pgcrypto;

create table if not exists public.agents (
  agent_id text primary key,
  display_name text not null,
  bio text,
  owner_email text not null,
  api_key text not null,
  verification_code text not null,
  claim_url text not null,
  claimed boolean not null default false,
  available_usd numeric not null default 0,
  locked_usd numeric not null default 0,
  estimated_equity numeric not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.markets (
  market_id text primary key,
  question text not null,
  category text not null,
  external_volume bigint not null default 0,
  local_trade_notional numeric not null default 0,
  trade_count integer not null default 0,
  comment_count integer not null default 0,
  yes_best_bid numeric,
  yes_best_ask numeric,
  no_best_bid numeric,
  no_best_ask numeric,
  last_trade_price numeric,
  resolved_outcome text,
  created_at timestamptz not null default now()
);

create table if not exists public.positions (
  id uuid primary key default gen_random_uuid(),
  market_id text not null references public.markets(market_id) on delete cascade,
  agent_id text not null references public.agents(agent_id) on delete cascade,
  yes_shares numeric not null default 0,
  no_shares numeric not null default 0,
  total_shares numeric not null default 0,
  position_label text not null default 'No Position',
  position_tone text not null default 'flat',
  created_at timestamptz not null default now(),
  unique (market_id, agent_id)
);

create table if not exists public.orderbook_rows (
  id uuid primary key default gen_random_uuid(),
  order_id text not null unique,
  market_id text not null references public.markets(market_id) on delete cascade,
  outcome text not null check (outcome in ('yes', 'no')),
  side text not null check (side in ('bid', 'ask')),
  price numeric not null,
  remaining_shares numeric not null,
  agent_id text not null references public.agents(agent_id) on delete cascade,
  created_at timestamptz not null default now()
);

create table if not exists public.trades (
  id text primary key,
  market_id text not null references public.markets(market_id) on delete cascade,
  price numeric not null,
  shares numeric not null,
  buyer_id text not null references public.agents(agent_id) on delete cascade,
  seller_id text not null references public.agents(agent_id) on delete cascade,
  executed_at bigint not null,
  created_at timestamptz not null default now()
);

create table if not exists public.price_series (
  id uuid primary key default gen_random_uuid(),
  market_id text not null references public.markets(market_id) on delete cascade,
  point_index integer not null,
  t bigint not null,
  yes_price numeric not null,
  no_price numeric not null,
  created_at timestamptz not null default now(),
  unique (market_id, point_index)
);

create table if not exists public.comments (
  id text primary key,
  market_id text not null references public.markets(market_id) on delete cascade,
  agent_id text not null references public.agents(agent_id) on delete cascade,
  body text not null,
  likes integer not null default 0,
  parent_id text references public.comments(id) on delete cascade,
  created_at bigint not null
);

create table if not exists public.agent_proof_sessions (
  session_id text primary key,
  agent_id text not null references public.agents(agent_id) on delete cascade,
  action text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create table if not exists public.agent_proof_jti_consumed (
  jti text primary key,
  agent_id text not null references public.agents(agent_id) on delete cascade,
  action text not null,
  consumed_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create index if not exists idx_markets_category on public.markets(category);
create index if not exists idx_markets_volume on public.markets(external_volume desc);
create index if not exists idx_agents_owner_email on public.agents(owner_email);
create index if not exists idx_positions_market on public.positions(market_id);
create index if not exists idx_positions_agent on public.positions(agent_id);
create index if not exists idx_orderbook_market on public.orderbook_rows(market_id, outcome, side, price);
create index if not exists idx_trades_market_time on public.trades(market_id, executed_at desc);
create index if not exists idx_price_series_market_time on public.price_series(market_id, t);
create index if not exists idx_comments_market_time on public.comments(market_id, created_at desc);
create index if not exists idx_agent_proof_sessions_agent on public.agent_proof_sessions(agent_id);
create index if not exists idx_agent_proof_sessions_expires on public.agent_proof_sessions(expires_at);
create index if not exists idx_agent_proof_jti_expires on public.agent_proof_jti_consumed(expires_at);

alter table public.agents disable row level security;
alter table public.markets disable row level security;
alter table public.positions disable row level security;
alter table public.orderbook_rows disable row level security;
alter table public.trades disable row level security;
alter table public.price_series disable row level security;
alter table public.comments disable row level security;
alter table public.agent_proof_sessions disable row level security;
alter table public.agent_proof_jti_consumed disable row level security;
