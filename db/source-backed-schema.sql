create extension if not exists vector;

create table if not exists personas (
  id text primary key,
  name text not null,
  role text not null,
  segment text not null,
  tags text[] not null default '{}',
  trust_threshold numeric not null,
  prompt text not null,
  tools text[] not null default '{}',
  non_negotiables text[] not null default '{}',
  source_confidence numeric not null check (source_confidence >= 0 and source_confidence <= 1),
  freshness text not null,
  scope text not null,
  embedding vector(64),
  embedding_provider text not null default 'deterministic',
  embedding_model text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists persona_knowledge_bundles (
  id text primary key,
  persona_id text not null references personas(id) on delete cascade,
  knowledge text[] not null default '{}',
  source_confidence numeric not null check (source_confidence >= 0 and source_confidence <= 1),
  freshness text not null,
  scope text not null,
  embedding vector(64),
  embedding_provider text not null default 'deterministic',
  created_at timestamptz not null default now()
);

create table if not exists persona_traits (
  id text primary key,
  persona_id text not null references personas(id) on delete cascade,
  trait text not null,
  trait_type text not null,
  source text not null,
  source_confidence numeric not null check (source_confidence >= 0 and source_confidence <= 1),
  freshness text not null,
  scope text not null,
  embedding vector(64),
  created_at timestamptz not null default now()
);

create table if not exists persona_memories (
  id text primary key,
  persona_id text not null references personas(id) on delete cascade,
  memory_type text not null,
  learned_objections text[] not null default '{}',
  calibration_notes text[] not null default '{}',
  preferred_evidence text[] not null default '{}',
  useful_fixes text[] not null default '{}',
  avoid_overweighting text[] not null default '{}',
  source_confidence numeric not null check (source_confidence >= 0 and source_confidence <= 1),
  freshness text not null,
  scope text not null,
  embedding vector(64),
  updated_at timestamptz not null default now()
);

create table if not exists evidence_items (
  id text primary key,
  run_id text not null,
  kind text not null,
  source_type text not null,
  text text not null,
  artifact jsonb not null default '{}'::jsonb,
  source_confidence numeric not null check (source_confidence >= 0 and source_confidence <= 1),
  freshness text not null,
  scope text not null,
  embedding vector(64),
  embedding_provider text not null default 'deterministic',
  created_at timestamptz not null default now()
);

create table if not exists simulation_runs (
  id text primary key,
  task_type text not null,
  input_hash text not null,
  synthetic_count integer not null,
  goal text,
  verdict text,
  score numeric,
  artifact jsonb not null default '{}'::jsonb,
  trace jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists persona_votes (
  id text primary key,
  run_id text not null references simulation_runs(id) on delete cascade,
  persona_id text not null,
  decision text not null,
  confidence numeric not null,
  trust_gap text,
  main_objection text,
  evidence_used jsonb not null default '[]'::jsonb,
  action_probability jsonb not null default '{}'::jsonb,
  disagreement jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists debate_rounds (
  id text primary key,
  run_id text not null references simulation_runs(id) on delete cascade,
  topic text not null,
  majority jsonb not null default '{}'::jsonb,
  dissent jsonb not null default '{}'::jsonb,
  changed_minds jsonb not null default '[]'::jsonb,
  resolution text,
  decisive_fix text,
  created_at timestamptz not null default now()
);

create table if not exists final_reports (
  id text primary key,
  run_id text not null references simulation_runs(id) on delete cascade,
  task_type text not null,
  verdict text,
  score numeric,
  synthetic_digest jsonb not null default '{}'::jsonb,
  public_artifact jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists calibration_feedback (
  id text primary key,
  run_id text,
  persona_id text,
  feedback_type text not null,
  value text not null,
  confirmed boolean,
  useful_fix text,
  created_at timestamptz not null default now()
);
