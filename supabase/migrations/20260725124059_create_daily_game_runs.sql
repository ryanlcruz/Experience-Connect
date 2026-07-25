
create table if not exists public.daily_game_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.usuarios(id) on delete cascade,
  game_key text not null check (game_key ~ '^[a-z0-9][a-z0-9_-]{1,80}$'),
  game_version text not null check (char_length(game_version) between 1 and 64),
  run_id text not null unique check (run_id ~ '^[A-Za-z0-9_-]{16,128}$'),
  game_date date not null default current_date,
  outcome text not null check (outcome in ('experience_recovered', 'problem_controlled', 'risky_victory', 'rupture', 'pressure_unresolved')),
  score integer not null check (score >= 0 and score <= 1000),
  trust_remaining smallint not null check (trust_remaining between 0 and 100),
  pressure_remaining smallint not null check (pressure_remaining between 0 and 100),
  rounds jsonb not null default '[]'::jsonb,
  completed_at timestamptz not null default now(),
  unique (user_id, game_key, game_date)
);

create index if not exists daily_game_runs_user_game_date_idx
  on public.daily_game_runs (user_id, game_key, game_date desc);

alter table public.daily_game_runs enable row level security;


revoke all on table public.daily_game_runs from anon, authenticated;
grant select, insert, update, delete on table public.daily_game_runs to service_role;
