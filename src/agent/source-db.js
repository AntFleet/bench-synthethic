import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

export const SOURCE_BACKED_DB_VERSION = 'source-backed-db.v1';
export const DEFAULT_SOURCE_DB_PATH = join(dirname(fileURLToPath(import.meta.url)), '../../.synthetic-source-db/source-db.json');
export const SOURCE_BACKED_DB_TABLES = Object.freeze([
  'personas',
  'persona_knowledge_bundles',
  'persona_traits',
  'persona_memories',
  'evidence_items',
  'simulation_runs',
  'persona_votes',
  'debate_rounds',
  'final_reports',
  'calibration_feedback',
]);

const EMPTY_DB = Object.freeze(Object.fromEntries(SOURCE_BACKED_DB_TABLES.map((table) => [table, Object.freeze([])])));
const DEFAULT_METADATA = Object.freeze({ sourceConfidence: 0.72, freshness: 'seeded_static_v1', scope: 'synthetic_panel_persona' });

export function buildPostgresSourceSchema() {
  return `
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
`;
}

export function createSourceBackedStore({ recordsPath = DEFAULT_SOURCE_DB_PATH } = {}) {
  const path = recordsPath;
  const state = loadState(path);
  function persist() {
    if (!path) return;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ schemaVersion: SOURCE_BACKED_DB_VERSION, tables: state }, null, 2));
  }
  return Object.freeze({
    schemaVersion: SOURCE_BACKED_DB_VERSION,
    storage: path ? 'json_file_postgres_shape' : 'memory_postgres_shape',
    recordsPath: path,
    upsert(table, row, key = 'id') {
      assertTable(table);
      const clean = sanitizeRow(row);
      const index = state[table].findIndex((item) => item[key] === clean[key]);
      if (index >= 0) state[table][index] = { ...state[table][index], ...clean };
      else state[table].push(clean);
      persist();
      return clean;
    },
    insert(table, row) {
      assertTable(table);
      const clean = sanitizeRow(row);
      state[table].push(clean);
      persist();
      return clean;
    },
    list(table) {
      assertTable(table);
      return state[table].map((row) => structuredClone(row));
    },
    snapshot() {
      return structuredClone(state);
    },
    clear() {
      for (const table of SOURCE_BACKED_DB_TABLES) state[table] = [];
      persist();
    },
  });
}


export function createPostgresSourceStore({ connectionString = process.env.SOURCE_DATABASE_URL || process.env.DATABASE_URL || 'postgresql:///synthetic_users_v41', dryRun = false, sql = buildPostgresSourceSchema(), namespace = '' } = {}) {
  const safeConnectionString = redactConnectionString(connectionString);
  if (dryRun) {
    return Object.freeze({
      schemaVersion: SOURCE_BACKED_DB_VERSION,
      storage: 'postgres_pgvector_dry_run',
      ready: { ok: true, sql, connectionString: safeConnectionString },
    });
  }
  const psql = process.env.PSQL_BIN || 'psql';
  const args = ['-d', connectionString, '-v', 'ON_ERROR_STOP=1', '-q'];
  const execSql = (statement, { tuplesOnly = false } = {}) => {
    const finalArgs = tuplesOnly ? ['-d', connectionString, '-v', 'ON_ERROR_STOP=1', '-q', '-t', '-A'] : args;
    return execFileSync(psql, finalArgs, { input: statement, encoding: 'utf8', cwd: '/tmp', maxBuffer: 10_000_000, env: quietPostgresEnv() });
  };
  try {
    execSql(sql);
  } catch (error) {
    return Object.freeze({
      schemaVersion: SOURCE_BACKED_DB_VERSION,
      storage: 'postgres_pgvector_unavailable',
      ready: { ok: false, connectionString: safeConnectionString, error: String(error?.message || error).slice(0, 500) },
    });
  }
  const store = {
    schemaVersion: SOURCE_BACKED_DB_VERSION,
    storage: namespace ? `postgres_pgvector:${namespace}` : 'postgres_pgvector',
    connectionString: safeConnectionString,
    ready: { ok: true, connectionString: safeConnectionString },
    upsert(table, row, key = 'id') {
      assertTable(table);
      const clean = sanitizeRow(row);
      const columns = Object.keys(clean).filter((column) => clean[column] !== undefined);
      const assignments = columns.filter((column) => column !== key).map((column) => `${quoteIdent(column)} = excluded.${quoteIdent(column)}`).join(', ');
      const statement = `insert into ${quoteIdent(table)} (${columns.map(quoteIdent).join(', ')}) values (${columns.map((column) => sqlValue(column, clean[column])).join(', ')}) on conflict (${quoteIdent(key)}) do update set ${assignments || `${quoteIdent(key)} = excluded.${quoteIdent(key)}`} returning to_jsonb(${quoteIdent(table)}.*);`;
      return parseSingleJson(execSql(statement, { tuplesOnly: true }));
    },
    insert(table, row) {
      assertTable(table);
      const clean = sanitizeRow(row);
      const columns = Object.keys(clean).filter((column) => clean[column] !== undefined);
      const statement = `insert into ${quoteIdent(table)} (${columns.map(quoteIdent).join(', ')}) values (${columns.map((column) => sqlValue(column, clean[column])).join(', ')}) returning to_jsonb(${quoteIdent(table)}.*);`;
      return parseSingleJson(execSql(statement, { tuplesOnly: true }));
    },
    list(table) {
      assertTable(table);
      const raw = execSql(`select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from ${quoteIdent(table)} t;`, { tuplesOnly: true });
      return JSON.parse(raw.trim() || '[]');
    },
    snapshot() {
      return Object.fromEntries(SOURCE_BACKED_DB_TABLES.map((table) => [table, store.list(table)]));
    },
    clear() {
      execSql(`truncate table final_reports, debate_rounds, persona_votes, simulation_runs, evidence_items, calibration_feedback, persona_memories, persona_knowledge_bundles, personas restart identity cascade;`);
    },
  };
  return Object.freeze(store);
}


export function createRuntimeSourceStore({ preferPostgres = process.env.SOURCE_DB_BACKEND === 'postgres' || Boolean(process.env.SOURCE_DATABASE_URL || process.env.DATABASE_URL), recordsPath = DEFAULT_SOURCE_DB_PATH } = {}) {
  if (preferPostgres) {
    try {
      const pgStore = createPostgresSourceStore({ connectionString: process.env.SOURCE_DATABASE_URL || process.env.DATABASE_URL || 'postgresql:///synthetic_users_v41' });
      if (pgStore.ready?.ok) return pgStore;
    } catch {
      // Fall through to JSON store.
    }
  }
  return createSourceBackedStore({ recordsPath });
}


export function summarizeSourceHealth({ store = null, preferPostgres = process.env.SOURCE_DB_BACKEND === 'postgres' || Boolean(process.env.SOURCE_DATABASE_URL || process.env.DATABASE_URL), connectionString = process.env.SOURCE_DATABASE_URL || process.env.DATABASE_URL || 'postgresql:///synthetic_users_v41' } = {}) {
  const requestedBackend = preferPostgres ? 'postgres' : 'json';
  let pgProbe = null;
  if (preferPostgres) {
    try {
      const probe = createPostgresSourceStore({ connectionString });
      pgProbe = { ok: Boolean(probe.ready?.ok), storage: probe.storage, error: probe.ready?.error || null };
    } catch (error) {
      pgProbe = { ok: false, storage: 'postgres_probe_failed', error: String(error?.message || error).slice(0, 500) };
    }
  }
  const sourceStore = store || (pgProbe?.ok ? createPostgresSourceStore({ connectionString }) : createSourceBackedStore());
  const activeBackend = /^postgres_pgvector/.test(sourceStore.storage || '') ? 'postgres' : 'json';
  const fallbackReason = activeBackend === 'json'
    ? (!preferPostgres ? 'postgres_not_requested' : (pgProbe?.error || pgProbe?.storage || 'postgres_unavailable'))
    : null;
  const counts = Object.fromEntries(SOURCE_BACKED_DB_TABLES.map((table) => [table, safeList(sourceStore, table).length]));
  const runs = safeList(sourceStore, 'simulation_runs').sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
  const latestRun = runs[0] || null;
  const evidence = safeList(sourceStore, 'evidence_items').sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
  const latestEmbedded = evidence.find((row) => row.embedding_provider || row.embedding_model || normalizeEmbedding(row.embedding).length) || null;
  const pgvector = activeBackend === 'postgres' ? readPgvectorVersion(connectionString) : { ok: false, version: null, error: 'not_postgres_backend' };
  return {
    schemaVersion: SOURCE_BACKED_DB_VERSION,
    ok: activeBackend === 'postgres' ? Boolean(pgvector.ok) : true,
    requestedBackend,
    activeBackend,
    storage: sourceStore.storage || 'unknown',
    fallbackReason,
    pgvector,
    rowCounts: counts,
    latestRun: latestRun ? {
      id: latestRun.id || latestRun.run_id || null,
      taskType: latestRun.task_type || latestRun.taskType || null,
      syntheticCount: Number(latestRun.synthetic_count || latestRun.syntheticCount || 0),
      createdAt: latestRun.created_at || latestRun.createdAt || null,
    } : null,
    counts: {
      evidence: counts.evidence_items || 0,
      votes: counts.persona_votes || 0,
      debates: counts.debate_rounds || 0,
      finalReports: counts.final_reports || 0,
      calibrationFeedback: counts.calibration_feedback || 0,
    },
    embedding: {
      provider: latestEmbedded?.embedding_provider || process.env.SOURCE_EMBEDDING_PROVIDER || 'deterministic',
      model: latestEmbedded?.embedding_model || process.env.SOURCE_EMBEDDING_MODEL || 'hashing-v1',
      dimensions: normalizeEmbedding(latestEmbedded?.embedding).length || 64,
    },
  };
}

function safeList(store, table) {
  try {
    return store?.list ? store.list(table) : [];
  } catch {
    return [];
  }
}

function quietPostgresEnv() {
  return { ...process.env, PGOPTIONS: [process.env.PGOPTIONS, '-c client_min_messages=warning'].filter(Boolean).join(' ') };
}

function readPgvectorVersion(connectionString = process.env.SOURCE_DATABASE_URL || process.env.DATABASE_URL || 'postgresql:///synthetic_users_v41') {
  try {
    const raw = execFileSync(process.env.PSQL_BIN || 'psql', ['-d', connectionString, '-t', '-A', '-c', "select extversion from pg_extension where extname = 'vector' limit 1"], { encoding: 'utf8', cwd: '/tmp', maxBuffer: 1_000_000, env: quietPostgresEnv() }).trim();
    return { ok: Boolean(raw), version: raw || null };
  } catch (error) {
    return { ok: false, version: null, error: String(error?.message || error).slice(0, 500) };
  }
}


export async function loadPersonasFromSourceStore({ store = createSourceBackedStore(), fallbackPersonas = [] } = {}) {
  const rows = store.list('personas');
  if (!rows.length) return { schemaVersion: SOURCE_BACKED_DB_VERSION, source: 'fallback_js', personas: fallbackPersonas };
  const knowledgeByPersona = new Map(store.list('persona_knowledge_bundles').map((row) => [row.persona_id, row]));
  const traitsByPersona = groupBy(store.list('persona_traits'), 'persona_id');
  const personas = rows.map((row) => {
    const kb = knowledgeByPersona.get(row.id) || {};
    return {
      id: row.id,
      name: row.name,
      role: row.role,
      segment: row.segment,
      tags: array(row.tags),
      trustThreshold: Number(row.trust_threshold || row.trustThreshold || 0),
      prompt: row.prompt,
      knowledge: array(kb.knowledge),
      tools: array(row.tools),
      nonNegotiables: array(row.non_negotiables || row.nonNegotiables),
      sourceConfidence: Number(row.source_confidence || row.sourceConfidence || 0),
      freshness: row.freshness,
      scope: row.scope,
      traitProvenance: array(traitsByPersona.get(row.id)).map((trait) => ({ trait: trait.trait, type: trait.trait_type, source: trait.source, confidence: Number(trait.source_confidence || 0), freshness: trait.freshness, scope: trait.scope })),
      embedding: normalizeEmbedding(row.embedding),
    };
  });
  return { schemaVersion: SOURCE_BACKED_DB_VERSION, source: 'source_db', personas };
}


function buildPersonaTraitProvenance(persona = {}, meta = DEFAULT_METADATA) {
  const base = [
    { traitType: 'role', trait: persona.role, source: 'persona_seed_role', scope: 'persona_role_trait' },
    { traitType: 'segment', trait: persona.segment, source: 'persona_seed_segment', scope: 'persona_segment_trait' },
    { traitType: 'trust_threshold', trait: `trust_threshold:${Number(persona.trustThreshold || 0).toFixed(2)}`, source: 'persona_seed_threshold', scope: 'persona_decision_trait' },
    { traitType: 'evidence_policy', trait: array(persona.tools).join(', '), source: 'persona_seed_tools', scope: 'persona_tool_trait' },
  ];
  for (const tag of array(persona.tags).slice(0, 4)) base.push({ traitType: 'tag', trait: tag, source: 'persona_seed_tags', scope: 'persona_targeting_trait' });
  for (const item of array(persona.knowledge).slice(0, 3)) base.push({ traitType: 'knowledge', trait: item, source: 'persona_seed_knowledge', scope: 'persona_knowledge_trait' });
  return base
    .filter((item) => String(item.trait || '').trim())
    .map((item) => ({ ...item, trait: String(item.trait).slice(0, 240), sourceConfidence: meta.sourceConfidence, freshness: meta.freshness }));
}

export async function seedPersonasToSourceStore({ store = createSourceBackedStore(), personas = [] } = {}) {
  let personasSeeded = 0;
  let knowledgeBundlesSeeded = 0;
  let traitRowsSeeded = 0;
  let memorySeeded = 0;
  for (const persona of personas) {
    const meta = normalizeSourceMetadata(persona, DEFAULT_METADATA);
    store.upsert('personas', {
      id: persona.id,
      name: persona.name,
      role: persona.role,
      segment: persona.segment,
      tags: array(persona.tags),
      trust_threshold: Number(persona.trustThreshold),
      prompt: persona.prompt,
      tools: array(persona.tools),
      non_negotiables: array(persona.nonNegotiables),
      source_confidence: meta.sourceConfidence,
      freshness: meta.freshness,
      scope: meta.scope,
      embedding: buildSourceEmbedding(`${persona.name} ${persona.role} ${persona.segment} ${array(persona.tags).join(' ')} ${array(persona.knowledge).join(' ')}`),
      updated_at: now(),
    });
    personasSeeded += 1;
    store.upsert('persona_knowledge_bundles', {
      id: `kb_${persona.id}`,
      persona_id: persona.id,
      knowledge: array(persona.knowledge),
      source_confidence: meta.sourceConfidence,
      freshness: meta.freshness,
      scope: 'persona_seed_knowledge',
      embedding: buildSourceEmbedding(array(persona.knowledge).join(' ')),
      created_at: now(),
    });
    knowledgeBundlesSeeded += 1;
    for (const trait of buildPersonaTraitProvenance(persona, meta)) {
      store.upsert('persona_traits', {
        id: `trait_${persona.id}_${trait.traitType}_${stableHash(trait.trait).slice(0, 8)}`,
        persona_id: persona.id,
        trait: trait.trait,
        trait_type: trait.traitType,
        source: trait.source,
        source_confidence: trait.sourceConfidence,
        freshness: trait.freshness,
        scope: trait.scope,
        embedding: buildSourceEmbedding(`${trait.traitType} ${trait.trait} ${trait.source}`),
        created_at: now(),
      });
      traitRowsSeeded += 1;
    }
    store.upsert('persona_memories', {
      id: `memory_${persona.id}`,
      persona_id: persona.id,
      memory_type: 'seed_prior',
      learned_objections: array(persona.nonNegotiables),
      calibration_notes: [`seeded from ${SOURCE_BACKED_DB_VERSION}`],
      preferred_evidence: array(persona.knowledge).slice(0, 4),
      useful_fixes: [persona.prompt].filter(Boolean),
      avoid_overweighting: ['tone without proof'],
      source_confidence: meta.sourceConfidence,
      freshness: meta.freshness,
      scope: 'persona_memory_seed',
      embedding: buildSourceEmbedding(`${array(persona.nonNegotiables).join(' ')} ${array(persona.knowledge).slice(0, 4).join(' ')}`),
      updated_at: now(),
    });
    memorySeeded += 1;
  }
  return { schemaVersion: SOURCE_BACKED_DB_VERSION, personasSeeded, knowledgeBundlesSeeded, traitRowsSeeded, memorySeeded };
}

export async function ingestEvidenceToSourceStore({ store = createSourceBackedStore(), runId = makeId('run'), input = '', plan = {}, evidence = [], toolResults = [], collectorPack = null } = {}) {
  const rows = [];
  const push = (raw, override = {}) => {
    const kind = override.kind || raw?.kind || 'raw_brief';
    const meta = evidenceMetadata({ kind, raw, plan, input });
    const row = store.insert('evidence_items', {
      id: makeId('evidence'),
      run_id: runId,
      kind,
      source_type: override.sourceType || inferEvidenceSourceType(kind, raw, input),
      text: String(raw?.text || raw?.summary || raw || '').replace(/\s+/g, ' ').slice(0, 2000),
      artifact: raw?.artifact || {},
      source_confidence: meta.sourceConfidence,
      freshness: meta.freshness,
      scope: meta.scope,
      embedding: buildSourceEmbedding(String(raw?.text || raw?.summary || raw || '')),
      created_at: now(),
    });
    rows.push(row);
  };
  if (String(input || '').trim()) push({ kind: 'raw_brief', text: input }, { kind: 'raw_brief', sourceType: 'raw_brief' });
  for (const item of evidence || []) push(item);
  for (const tool of toolResults || []) {
    if (tool?.artifact || tool?.summary) push({ kind: tool.kind || tool.name || 'tool_result', text: tool.summary, artifact: tool.artifact }, { sourceType: 'tool_result' });
  }
  for (const item of collectorPack?.collectorEvidence || []) push(item, { sourceType: 'collector' });
  return { schemaVersion: SOURCE_BACKED_DB_VERSION, count: rows.length, kinds: [...new Set(rows.map((row) => row.kind))], rows };
}

export async function persistSyntheticRunToSourceStore({ store = createSourceBackedStore(), runId = makeId('run'), input = '', plan = {}, personaPanel = null, artifact = {}, trace = [] } = {}) {
  store.upsert('simulation_runs', {
    id: runId,
    task_type: plan.taskType || artifact.taskType || 'brief_review',
    input_hash: stableHash(input),
    synthetic_count: Number(plan.syntheticCount || personaPanel?.selected?.length || 10),
    goal: plan.goal || artifact.goal || '',
    verdict: artifact.verdict || '',
    score: Number.isFinite(Number(artifact.score)) ? Number(artifact.score) : null,
    artifact: compactArtifact(artifact),
    trace,
    created_at: now(),
  });
  const responses = personaPanel?.responses || [];
  for (const response of responses) {
    store.insert('persona_votes', {
      id: makeId('vote'),
      run_id: runId,
      persona_id: response.personaId,
      decision: response.decision,
      confidence: Number(response.confidence || 0),
      trust_gap: response.trustGap || '',
      main_objection: response.mainObjection || '',
      evidence_used: array(response.evidenceUsed),
      action_probability: personaPanel?.actionProbability || {},
      disagreement: personaPanel?.disagreementRound ? { topic: personaPanel.disagreementRound.topic, resolution: personaPanel.disagreementRound.resolution } : {},
      created_at: now(),
    });
  }
  let debateRoundsPersisted = 0;
  if (personaPanel?.disagreementRound) {
    const debate = personaPanel.disagreementRound;
    store.insert('debate_rounds', {
      id: makeId('debate'),
      run_id: runId,
      topic: debate.topic || 'Evidence gap',
      majority: debate.majority || {},
      dissent: debate.dissent || {},
      changed_minds: debate.changedMinds || [],
      resolution: debate.resolution || '',
      decisive_fix: debate.decisiveFix || '',
      created_at: now(),
    });
    debateRoundsPersisted = 1;
  }
  store.insert('final_reports', {
    id: makeId('report'),
    run_id: runId,
    task_type: artifact.taskType || plan.taskType || 'brief_review',
    verdict: artifact.verdict || '',
    score: Number.isFinite(Number(artifact.score)) ? Number(artifact.score) : null,
    synthetic_digest: artifact.syntheticDigest || personaPanel?.panelDigest || {},
    public_artifact: compactArtifact(artifact),
    created_at: now(),
  });
  return { schemaVersion: SOURCE_BACKED_DB_VERSION, runId, votesPersisted: responses.length, debateRoundsPersisted, finalReportsPersisted: 1 };
}

export async function recordCalibrationFeedbackToSourceStore({ store = createSourceBackedStore(), runId = '', personaId = '', type = 'thumbs', value = '', confirmed = null, usefulFix = '' } = {}) {
  const row = store.insert('calibration_feedback', {
    id: makeId('feedback'),
    run_id: runId,
    persona_id: personaId,
    feedback_type: type,
    value: String(value || '').slice(0, 1000),
    confirmed: confirmed === null ? null : Boolean(confirmed),
    useful_fix: String(usefulFix || '').slice(0, 500),
    created_at: now(),
  });
  if (personaId) {
    const existing = store.list('persona_memories').find((item) => item.persona_id === personaId) || {
      id: `memory_${personaId}`,
      persona_id: personaId,
      memory_type: 'calibration',
      learned_objections: [],
      calibration_notes: [],
      preferred_evidence: [],
      useful_fixes: [],
      avoid_overweighting: [],
      source_confidence: 0.68,
      freshness: 'runtime_feedback',
      scope: 'persona_calibration_memory',
    };
    store.upsert('persona_memories', {
      ...existing,
      calibration_notes: unique([...(existing.calibration_notes || []), `${type}: ${String(value || '').slice(0, 220)}`]).slice(-12),
      useful_fixes: unique([...(existing.useful_fixes || []), usefulFix].filter(Boolean)).slice(-12),
      freshness: 'runtime_feedback',
      scope: 'persona_calibration_memory',
      embedding: buildSourceEmbedding(`${type} ${value} ${usefulFix}`),
      updated_at: now(),
    });
  }
  return { ok: true, schemaVersion: SOURCE_BACKED_DB_VERSION, feedback: row };
}

export function buildRoleSpecificToolPlan({ personas = [], plan = {}, collectorPack = null } = {}) {
  const taskType = plan.taskType || 'brief_review';
  const executions = personas.map((persona) => {
    const allowedTools = array(persona.tools);
    const collectorSignals = collectorPack?.signalsByPersona?.[persona.id] || [];
    return {
      personaId: persona.id,
      role: persona.role,
      segment: persona.segment,
      allowedTools,
      collectorSignals: collectorSignals.slice(0, 3),
      scope: 'role_specific_tool_policy',
    };
  }).filter((item) => item.allowedTools.length || item.collectorSignals.length);
  return { schemaVersion: SOURCE_BACKED_DB_VERSION, taskType, executions };
}



export async function buildProviderSourceEmbedding(text = '', { provider = process.env.SOURCE_EMBEDDING_PROVIDER || 'deterministic', model = process.env.SOURCE_EMBEDDING_MODEL || 'text-embedding-3-small', dimensions = 64, fetchImpl = globalThis.fetch } = {}) {
  const fallback = () => ({ provider: 'deterministic', model: 'hashing-v1', dimensions, embedding: buildSourceEmbedding(text, { dimensions }) });
  if (!provider || provider === 'deterministic' || provider === 'hashing') return fallback();
  if (provider === 'openai') {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey || typeof fetchImpl !== 'function') return { ...fallback(), providerFallbackReason: 'openai_unavailable' };
    try {
      const response = await fetchImpl('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model, input: String(text || '').slice(0, 8000), dimensions }),
      });
      if (!response.ok) return { ...fallback(), providerFallbackReason: `openai_http_${response.status}` };
      const payload = await response.json();
      const embedding = array(payload?.data?.[0]?.embedding).map(Number).filter(Number.isFinite).slice(0, dimensions);
      if (!embedding.length) return { ...fallback(), providerFallbackReason: 'openai_empty_embedding' };
      return { provider: 'openai', model, dimensions: embedding.length, embedding };
    } catch {
      return { ...fallback(), providerFallbackReason: 'openai_exception' };
    }
  }
  return { ...fallback(), providerFallbackReason: `unsupported_${provider}` };
}

export function sourceContextForSelectedPersonas({ store = createSourceBackedStore(), personas = [], query = '', limit = 5 } = {}) {
  const selectedPersonas = Array.isArray(personas) ? personas.filter(Boolean) : [];
  const byPersona = selectedPersonas.map((persona) => {
    const retrieved = retrieveSourceContextForPersona({ store, personaId: persona.id, query, limit });
    return { personaId: persona.id, items: retrieved.items };
  });
  return { schemaVersion: SOURCE_BACKED_DB_VERSION, query, byPersona };
}

export async function enrichRunEvidenceEmbeddings({ store = createSourceBackedStore(), runId = '', provider = process.env.SOURCE_EMBEDDING_PROVIDER || 'deterministic' } = {}) {
  const rows = store.list('evidence_items').filter((row) => !runId || row.run_id === runId);
  let enriched = 0;
  let providerUsed = 'deterministic';
  for (const row of rows) {
    const result = await buildProviderSourceEmbedding(row.text || '', { provider });
    providerUsed = result.provider || providerUsed;
    store.upsert('evidence_items', { ...row, embedding: result.embedding, embedding_provider: result.provider, embedding_model: result.model });
    enriched += 1;
  }
  return { schemaVersion: SOURCE_BACKED_DB_VERSION, runId, enriched, provider: providerUsed };
}

export async function ingestExpandedEvidenceSourcesToSourceStore({ store = createSourceBackedStore(), runId = makeId('run'), plan = {}, sources = {} } = {}) {
  const evidence = [];
  for (const url of array(sources.urls)) evidence.push({ kind: 'page_surface', text: `URL evidence: ${url}`, sourceUrl: url, scope: 'url_page_evidence', freshness: 'runtime_url_reference' });
  for (const token of sources.tokens || []) evidence.push({ kind: 'token_context', text: `Token evidence: ${token.chain || 'unknown'} ${token.contract || ''} market cap ${token.marketCap || 'unknown'} holders ${token.holders || 'unknown'}`, artifact: token, scope: 'token_market_evidence', freshness: 'runtime_token_observation' });
  for (const doc of sources.docs || []) evidence.push({ kind: 'docs', text: `${doc.title || 'Docs'}: ${doc.text || doc.url || ''}`, artifact: doc, scope: 'docs_evidence', freshness: 'runtime_docs_observation' });
  for (const brief of array(sources.rawBriefs)) evidence.push({ kind: 'raw_brief', text: brief, scope: 'raw_brief_evidence', freshness: 'current_user_input' });
  for (const thread of sources.xThreads || []) evidence.push({ kind: 'x_thread', text: thread.text || thread.url || '', artifact: thread, scope: 'x_social_evidence', freshness: 'runtime_social_observation' });
  for (const item of sources.hnReddit || []) evidence.push({ kind: 'community_thread', text: item.text || item.url || '', artifact: item, scope: 'community_evidence', freshness: 'runtime_community_observation' });
  for (const review of sources.reviews || []) evidence.push({ kind: 'review', text: review.text || review.url || '', artifact: review, scope: 'review_evidence', freshness: 'runtime_review_observation' });
  const result = await ingestEvidenceToSourceStore({ store, runId, plan, evidence });
  return { ...result, sourceTypes: [...new Set(result.rows.map((row) => row.source_type))] };
}

export function buildSourceEmbedding(text = '', { dimensions = 64 } = {}) {
  const vector = Array.from({ length: dimensions }, () => 0);
  const tokens = String(text || '').toLowerCase().match(/[a-z0-9_]+/g) || [];
  for (const token of tokens) {
    let hash = 2166136261;
    for (const ch of token) {
      hash ^= ch.charCodeAt(0);
      hash = Math.imul(hash, 16777619);
    }
    const index = Math.abs(hash >>> 0) % dimensions;
    vector[index] += 1;
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vector.map((value) => Number((value / norm).toFixed(6)));
}

export function retrieveSourceContextForPersona({ store = createSourceBackedStore(), personaId = '', query = '', limit = 5 } = {}) {
  const queryEmbedding = buildSourceEmbedding(query);
  const rows = [
    ...store.list('persona_knowledge_bundles').filter((row) => !personaId || row.persona_id === personaId).map((row) => ({ ...row, table: 'persona_knowledge_bundles', text: array(row.knowledge).join(' ') })),
    ...store.list('persona_memories').filter((row) => !personaId || row.persona_id === personaId).map((row) => ({ ...row, table: 'persona_memories', text: [...array(row.calibration_notes), ...array(row.preferred_evidence), ...array(row.useful_fixes)].join(' ') })),
    ...store.list('evidence_items').map((row) => ({ ...row, table: 'evidence_items', text: row.text })),
  ];
  const items = rows.map((row) => {
    const existingEmbedding = normalizeEmbedding(row.embedding);
    const embedding = existingEmbedding.length ? existingEmbedding : buildSourceEmbedding(row.text || '');
    return { ...row, score: cosine(queryEmbedding, embedding) };
  }).filter((row) => row.score > 0).sort((a, b) => b.score - a.score).slice(0, limit);
  return { schemaVersion: SOURCE_BACKED_DB_VERSION, personaId, query, items };
}

export async function executeRoleSpecificChecksToSourceStore({ store = createSourceBackedStore(), runId = makeId('run'), personas = [], plan = {}, collectorPack = null, evidencePack = [], input = '' } = {}) {
  const policy = buildRoleSpecificToolPlan({ personas, plan, collectorPack });
  const rows = [];
  for (const execution of policy.executions) {
    const concrete = runSelectiveRoleCheck({ execution, plan, collectorPack, evidencePack, input });
    const row = store.insert('evidence_items', {
      id: makeId('rolecheck'),
      run_id: runId,
      kind: concrete.kind,
      source_type: 'role_specific_check',
      text: concrete.text,
      artifact: { personaId: execution.personaId, allowedTools: execution.allowedTools, collectorSignals: execution.collectorSignals, result: concrete.result },
      source_confidence: concrete.sourceConfidence,
      freshness: 'runtime_role_check',
      scope: 'persona_selective_extra_check',
      embedding: buildSourceEmbedding(`${execution.role} ${execution.allowedTools.join(' ')} ${concrete.text}`),
      created_at: now(),
    });
    rows.push(row);
  }
  return { schemaVersion: SOURCE_BACKED_DB_VERSION, executed: rows.length, rows };
}

export function summarizeLatestSourceRun({ store = createSourceBackedStore(), runId = '' } = {}) {
  const runs = store.list('simulation_runs').sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')));
  const run = runId ? runs.find((item) => item.id === runId) : runs[runs.length - 1];
  if (!run) return { schemaVersion: SOURCE_BACKED_DB_VERSION, ok: false, error: 'No source-backed runs found.' };
  const id = run.id;
  const evidence = store.list('evidence_items').filter((row) => row.run_id === id);
  const votes = store.list('persona_votes').filter((row) => row.run_id === id);
  const debate = store.list('debate_rounds').filter((row) => row.run_id === id);
  const report = store.list('final_reports').filter((row) => row.run_id === id).at(-1) || null;
  const calibration = store.list('calibration_feedback').filter((row) => !row.run_id || row.run_id === id);
  const roleChecks = evidence.filter((row) => row.source_type === 'role_specific_check');
  return { schemaVersion: SOURCE_BACKED_DB_VERSION, ok: true, run, evidence, votes, debate, report, calibration, roleChecks };
}


function runSelectiveRoleCheck({ execution = {}, plan = {}, collectorPack = null, evidencePack = [], input = '' } = {}) {
  const role = `${execution.role || ''} ${execution.segment || ''} ${execution.personaId || ''}`.toLowerCase();
  const tools = array(execution.allowedTools);
  const collectorText = (Array.isArray(collectorPack?.collectorEvidence) ? collectorPack.collectorEvidence : []).map((item) => item.text || item.summary || '').join(' ');
  const evidenceText = (Array.isArray(evidencePack) ? evidencePack : []).map((item) => item.text || item.summary || '').join(' ');
  const text = `${input} ${collectorText} ${evidenceText}`.toLowerCase();
  if (tools.includes('liquidity_read') || tools.includes('holder_scan') || /token|security|trader|liquidity|market/.test(role) || plan.taskType === 'token_launch') {
    const hasMarket = /liquidity|holder|mcap|volume|contract|score|wake|bankr|rug|security/.test(text);
    return { kind: 'role_market_security_check', sourceConfidence: hasMarket ? 0.78 : 0.58, text: hasMarket ? 'Market/security role found token context worth weighting.' : 'Market/security role lacks market, holder, or contract proof.', result: { hasMarket } };
  }
  if (tools.includes('docs_scan') || /docs|api|developer|technical/.test(role)) {
    const hasDocs = /docs|api|github|quickstart|integration|webhook/.test(text);
    return { kind: 'role_docs_check', sourceConfidence: hasDocs ? 0.82 : 0.62, text: hasDocs ? 'Docs role found implementation proof signals: docs, API, quickstart, GitHub, or integration language.' : 'Docs role did not find enough implementation proof for a builder to trust the workflow.', result: { hasDocs } };
  }
  if (tools.includes('demo_scan') || tools.includes('proof_gap_scan') || /demo|proof|skeptic|founder/.test(role)) {
    const hasProof = /demo|case study|customer|screenshot|metrics|public artifact|proof|share url/.test(text);
    return { kind: 'role_demo_check', sourceConfidence: hasProof ? 0.8 : 0.6, text: hasProof ? 'Proof role found a visible artifact/demo signal.' : 'Proof role found claims before artifacts; needs a concrete demo or public example.', result: { hasProof } };
  }
  if (tools.includes('cta_map') || /ux|visitor|operator|growth/.test(role)) {
    const hasCta = /cta|button|try|start|sign up|pricing|onboarding/.test(text);
    return { kind: 'role_conversion_check', sourceConfidence: hasCta ? 0.76 : 0.58, text: hasCta ? 'Conversion role found a first-action path.' : 'Conversion role did not find a sharp first action.', result: { hasCta } };
  }
  return { kind: 'role_general_check', sourceConfidence: 0.64, text: 'Persona role performed a bounded selective check against the shared evidence pack.', result: { checked: true } };
}

function redactConnectionString(value = '') {
  return String(value || '').replace(/:\/\/([^:]+):([^@]+)@/, '://$1:[REDACTED]@');
}

function quoteIdent(value = '') {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function sqlValue(column = '', value) {
  const jsonbColumns = new Set(['artifact', 'trace', 'summary', 'public_artifact', 'vote', 'disagreement', 'metrics', 'evidence_used', 'action_probability', 'changed_minds', 'synthetic_digest', 'majority', 'dissent']);
  if ((value === undefined || value === null) && jsonbColumns.has(column)) return `'{}'::jsonb`;
  if (value === undefined || value === null) return 'null';
  if (column === 'embedding') return `'${JSON.stringify((Array.isArray(value) ? value : []).map(Number).filter(Number.isFinite))}'::vector`;
  if (jsonbColumns.has(column)) return `${sqlLiteral(JSON.stringify(value))}::jsonb`;
  if (Array.isArray(value)) return `array[${value.map((item) => sqlLiteral(String(item))).join(', ')}]::text[]`;
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'object') return `${sqlLiteral(JSON.stringify(value))}::jsonb`;
  if (/_at$/.test(column)) return `${sqlLiteral(String(value))}::timestamptz`;
  return sqlLiteral(String(value));
}

function sqlLiteral(value = '') {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function parseSingleJson(raw = '') {
  const text = String(raw || '').trim();
  if (!text) return null;
  return JSON.parse(text.split('\n').filter(Boolean).at(-1));
}

function normalizeSourceMetadata(raw = {}, fallback = DEFAULT_METADATA) {
  return {
    sourceConfidence: clamp(Number(raw.sourceConfidence ?? raw.source_confidence ?? fallback.sourceConfidence), 0, 1),
    freshness: String(raw.freshness || fallback.freshness),
    scope: String(raw.scope || fallback.scope),
  };
}

function evidenceMetadata({ kind = '', raw = {}, plan = {}, input = '' } = {}) {
  const sourceType = inferEvidenceSourceType(kind, raw, input);
  const confidenceBySource = { page_surface: 0.78, token_context: 0.76, docs: 0.72, raw_brief: 0.58, collector: 0.66, tool_result: 0.64, x_social: 0.55, hn_reddit_review: 0.5 };
  return {
    sourceConfidence: clamp(Number(raw?.sourceConfidence ?? confidenceBySource[sourceType] ?? 0.62), 0.4, 0.95),
    freshness: raw?.freshness || (sourceType === 'raw_brief' ? 'current_user_input' : 'runtime_observation'),
    scope: raw?.scope || evidenceScope(kind, plan),
  };
}

function inferEvidenceSourceType(kind = '', raw = {}, input = '') {
  const text = `${kind} ${raw?.text || raw?.summary || ''} ${input}`.toLowerCase();
  if (/page_surface|first_fold|visual|homepage|https?:\/\//.test(text)) return 'page_surface';
  if (/token|contract|liquidity|market|holder|0x[a-f0-9]{40}/.test(text)) return 'token_context';
  if (/docs|api|github|documentation/.test(text)) return 'docs';
  if (/x_|x_thread|twitter|social/.test(text)) return 'x_social';
  if (/hn|reddit|community|review/.test(text)) return 'community_review';
  if (/collector_/.test(kind)) return 'collector';
  if (kind === 'raw_brief' || kind === 'claim') return 'raw_brief';
  return 'tool_result';
}

function evidenceScope(kind = '', plan = {}) {
  if (/collector_/.test(kind)) return 'persona_collector_signal';
  if (plan?.taskType === 'token_launch') return 'token_review_evidence';
  if (plan?.taskType === 'page_review') return 'page_review_evidence';
  if (plan?.taskType === 'comparison') return 'comparison_evidence';
  return 'raw_brief_evidence';
}

function toolAllowedForTask(tool = '', taskType = '') {
  if (taskType === 'token_launch') return /liquidity|contract|holder|market|narrative|base|proof|privacy/.test(tool);
  if (taskType === 'page_review') return /page|proof|cta|docs|privacy|headline|pricing|workflow|artifact|friction|brand|jargon|reliability|differentiation|launch/.test(tool);
  if (taskType === 'comparison') return /comparison|regression|surface|proof|cta|friction|launch/.test(tool);
  return true;
}

function loadState(path) {
  const base = Object.fromEntries(SOURCE_BACKED_DB_TABLES.map((table) => [table, []]));
  if (!path || !existsSync(path)) return base;
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  const tables = parsed.tables || parsed;
  for (const table of SOURCE_BACKED_DB_TABLES) base[table] = Array.isArray(tables[table]) ? tables[table] : [];
  return base;
}

function compactArtifact(artifact = {}) {
  const { personaPanel, collectorEvidence, scoreCalibration, memoryFeedback, disagreementRound, runMemory, selectionProfile, ...safe } = artifact || {};
  return JSON.parse(JSON.stringify(safe));
}

function sanitizeRow(row = {}) {
  return JSON.parse(JSON.stringify(row, (key, value) => {
    if (/secret|password|token|apiKey|privateKey/i.test(key) && typeof value === 'string') return '[REDACTED]';
    return value;
  }));
}

function assertTable(table) {
  if (!SOURCE_BACKED_DB_TABLES.includes(table)) throw new Error(`Unknown source DB table: ${table}`);
}


function groupBy(rows = [], key = '') {
  const grouped = new Map();
  for (const row of rows || []) {
    const id = row?.[key];
    if (!id) continue;
    if (!grouped.has(id)) grouped.set(id, []);
    grouped.get(id).push(row);
  }
  return grouped;
}

function array(value) {
  return Array.isArray(value) ? value.map((item) => String(item || '').trim()).filter(Boolean) : [];
}

function unique(items) {
  return [...new Set(items.map((item) => String(item || '').trim()).filter(Boolean))];
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number.isFinite(value) ? value : min));
}


function normalizeEmbedding(value) {
  if (Array.isArray(value)) return value.map(Number).filter(Number.isFinite);
  if (typeof value === 'string') {
    return value.replace(/^\[|\]$/g, '').split(',').map(Number).filter(Number.isFinite);
  }
  return [];
}

function cosine(a = [], b = []) {
  const len = Math.min(a.length, b.length);
  let dot = 0;
  let an = 0;
  let bn = 0;
  for (let i = 0; i < len; i += 1) {
    dot += Number(a[i] || 0) * Number(b[i] || 0);
    an += Number(a[i] || 0) ** 2;
    bn += Number(b[i] || 0) ** 2;
  }
  return Number((dot / ((Math.sqrt(an) || 1) * (Math.sqrt(bn) || 1))).toFixed(6));
}

function now() {
  return new Date().toISOString();
}

function makeId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function stableHash(value = '') {
  let hash = 2166136261;
  for (const ch of String(value || '')) {
    hash ^= ch.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
