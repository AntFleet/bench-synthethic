import { planAgentTurn } from './agent-controller.js';
import { createAgentTools } from './tools.js';
import { runSpecialistPanel } from './specialists.js';
import { critiqueAgentArtifact } from './critic.js';
import { runHermesBrain, runHermesSoulReply, mergeHermesBrainArtifact } from './hermes-brain.js';
import { PERSONA_BANK, runPersonaPanel, selectPersonaPanel } from './personas.js';
import { SYNTHETIC_SOUL, buildSoulReply } from './soul.js';
import { normalizeSyntheticCount } from '../source-report-synthesis.js';
import { formatExternalSkillsUsed } from './external-skills.js';
import { buildSkillEvidencePack } from './skill-evidence-policy.js';
import { buildPersonaCollectorPack } from './persona-collectors.js';
import { calibrateScore } from './score-calibration.js';
import { recordPersonaRunMemory } from './persona-run-memory.js';
import { buildSyntheticDigest } from './synthetic-digest.js';
import { createRuntimeSourceStore, seedPersonasToSourceStore, loadPersonasFromSourceStore, ingestEvidenceToSourceStore, persistSyntheticRunToSourceStore, executeRoleSpecificChecksToSourceStore, enrichRunEvidenceEmbeddings, sourceContextForSelectedPersonas } from './source-db.js';

const OFFICIAL_SYNTHETIC_CA = '0xfe848a4e279e762ad409a84d4e164324b8d26ba3';

export const AGENT_RUNTIME = Object.freeze({
  name: 'SyntheticAI terminal',
  model: 'Local deterministic agent runtime',
  provider: 'Synthetic Users local runtime',
  hostedLlm: false,
  tools: ['planner', 'collectors', 'synthetic lens orchestration', 'critic', 'optional source report'],
  note: 'Synthetic answers product questions and pressure-tests surfaces without exposing secrets or operational internals.'
});

export async function runSyntheticUserAgentTurn({ input = '', history = [], tools = null, allowPaidMiroShark = false, toolOptions = {}, useHermesBrain = false, hermesBrain = null, hermesSoul = null, hermesOptions = {}, syntheticCount = 10 } = {}) {
  const selectedSyntheticCount = normalizeSyntheticCount(syntheticCount);
  const plan = { ...planAgentTurn({ input, history }), input, syntheticCount: selectedSyntheticCount };
  const toolset = { ...createAgentTools({ ...toolOptions, syntheticCount: selectedSyntheticCount }), ...(tools || {}) };
  const trace = [{ kind: 'plan', status: 'ok', taskType: plan.taskType, tools: plan.tools, specialists: plan.specialists, goal: plan.goal }];
  if (isConversationalTask(plan.taskType) && !allowPaidMiroShark) {
    const artifact = composeConversationArtifact({ plan });
    const deterministicReply = buildConversationReply(plan.taskType, input);
    if (useHermesBrain && !['greeting', 'privacy_safety', 'capabilities', 'usage_help', 'identity', 'project_knowledge', 'miroshark_capability', 'bankr_launch_packet', 'product_info'].includes(plan.taskType)) {
      const soul = hermesSoul || ((args) => runHermesSoulReply({ ...hermesOptions, ...args }));
      const soulResult = await soul({ input, history, plan });
      if (soulResult?.ok && soulResult.reply) {
        artifact.runtime = soulResult.runtime || artifact.runtime;
        artifact.soulRuntime = { ok: true, latencyMs: soulResult.latencyMs || 0 };
        trace.push({ kind: 'synthetic_soul', status: 'ok', summary: 'Synthetic conversational layer generated a safe reply.', latencyMs: soulResult.latencyMs || 0 });
        return { ok: true, reply: normalizeConversationReply({ reply: soulResult.reply, taskType: plan.taskType, input }), artifact, trace };
      }
      trace.push({ kind: 'synthetic_soul', status: 'fallback', summary: soulResult?.summary || 'Synthetic conversational layer unavailable; deterministic reply used.' });
    }
    return { ok: true, reply: normalizeConversationReply({ reply: deterministicReply, taskType: plan.taskType, input }), artifact, trace };
  }
  const toolResults = [];
  const evidence = [];

  if (plan.shouldAskForContext) {
    const specialists = runSpecialistPanel({ plan, evidence, toolResults });
    const critique = critiqueAgentArtifact({ plan, evidence, specialists });
    const skillEvidencePack = buildSkillEvidencePack({ toolResults, evidence, plan, input });
    const collectorPack = buildPersonaCollectorPack({ input, evidence: [...evidence, ...(skillEvidencePack.personaEvidence || [])], toolResults, plan });
    const sourceRoom = await prepareSourceBackedRoom({ input, plan, evidence, toolResults, collectorPack, maxPersonas: selectedSyntheticCount });
    const personaPanel = runPersonaPanel({ input, plan, context: { evidence, toolResults, skillEvidencePack, collectorPack, sourceContext: sourceRoom.sourceContext }, maxPersonas: selectedSyntheticCount, personas: sourceRoom.selectedPersonas });
    let artifact = { ...composeArtifact({ plan, evidence, specialists, critique, toolResults, personaPanel }), presentation: 'chat' };
    artifact.syntheticDigest = buildSyntheticDigest({ artifact, personaPanel, plan });
    const earlyTrace = [...trace, { kind: 'personas_loaded', status: 'ok', summary: `${personaPanel.totalLoaded} synthetic users loaded` }, { kind: 'personas_selected', status: 'ok', summary: `${personaPanel.selected.length} selected for ${plan.taskType}` }, { kind: 'persona_panel', status: 'needs_context', summary: personaPanel.summary }, { kind: 'synthetic_digest', status: 'needs_context', summary: artifact.syntheticDigest.topBlocker }];
    const sourcePersistence = await persistSourceBackedRun({ input, plan, evidence, toolResults, collectorPack, personaPanel, artifact, trace: earlyTrace, preparedSource: sourceRoom });
    artifact.sourcePersistence = sourcePersistence.publicSummary;
    artifact.feedbackRunId = sourcePersistence.publicSummary?.runId || '';
    const finalTrace = [...earlyTrace, sourcePersistence.trace, { kind: 'critic', status: 'needs_context', missingEvidence: critique.missingEvidence }];
    // Missing-context turns are intentionally chat-only. Do not run Hermes or render a fake report.
    return {
      ok: true,
      reply: buildMissingContextReply(plan),
      artifact,
      trace: finalTrace,
    };
  }

  const plannedTools = [...plan.tools];
  if (allowPaidMiroShark && !plannedTools.includes('attach_miroshark_source_report')) plannedTools.push('attach_miroshark_source_report');

  for (const toolName of plannedTools.slice(0, 7)) {
    if (toolName === 'attach_miroshark_source_report' && !allowPaidMiroShark) continue;
    const tool = toolset[toolName];
    if (!tool) {
      trace.push({ kind: 'tool', name: toolName, status: 'missing' });
      continue;
    }
    const started = Date.now();
    try {
      const result = await tool({ input, plan, evidence, history });
      const normalized = { name: toolName, latencyMs: Date.now() - started, ...normalizeToolResult(result) };
      toolResults.push(normalized);
      evidence.push(...(normalized.evidence || []));
      trace.push({ kind: 'tool', name: toolName, status: normalized.ok ? 'ok' : 'failed', summary: normalized.summary, latencyMs: normalized.latencyMs });
    } catch (error) {
      toolResults.push({ name: toolName, ok: false, summary: error.message, evidence: [] });
      trace.push({ kind: 'tool', name: toolName, status: 'failed', summary: error.message });
    }
  }

  const skillEvidencePack = buildSkillEvidencePack({ toolResults, evidence, plan, input });
  const collectorPack = buildPersonaCollectorPack({ input, evidence: [...evidence, ...(skillEvidencePack.personaEvidence || [])], toolResults, plan });
  const sourceRoom = await prepareSourceBackedRoom({ input, plan, evidence, toolResults, collectorPack, maxPersonas: selectedSyntheticCount });
  const personaPanel = runPersonaPanel({ input, plan, context: { evidence, toolResults, skillEvidencePack, collectorPack, sourceContext: sourceRoom.sourceContext }, maxPersonas: selectedSyntheticCount, personas: sourceRoom.selectedPersonas });
  trace.push({ kind: 'personas_loaded', status: 'ok', summary: `${personaPanel.totalLoaded} synthetic users loaded` });
  trace.push({ kind: 'personas_selected', status: 'ok', summary: `${personaPanel.selected.length} selected for ${plan.taskType}` });
  trace.push({ kind: 'persona_panel', status: 'ok', summary: `${personaPanel.responses.length} hidden votes, ${personaPanel.objectionClusters.length} objection clusters` });
  const specialists = runSpecialistPanel({ plan, evidence, toolResults, personaPanel }).slice(0, 3);
  const critique = critiqueAgentArtifact({ plan, evidence, specialists });
  let artifact = plan.taskType === 'market_forecast'
    ? composeMarketForecastArtifact({ plan, evidence, toolResults, personaPanel })
    : composeArtifact({ plan, evidence, specialists, critique, toolResults, personaPanel });
  if (useHermesBrain) {
    const brain = hermesBrain || ((args) => runHermesBrain({ ...hermesOptions, ...args }));
    const brainResult = await brain({ input, history, plan, artifact, personaPanel });
    if (brainResult?.ok) {
      artifact = mergeHermesBrainArtifact(artifact, brainResult);
      trace.push({ kind: 'hermes_brain', status: 'ok', summary: brainResult.artifact?.reasoningSummary || 'Hermes brain merged.', latencyMs: brainResult.latencyMs || 0 });
    } else {
      trace.push({ kind: 'hermes_brain', status: 'fallback', summary: brainResult?.summary || 'Hermes brain unavailable; local runtime used.' });
    }
  }
  if (shouldRecomputeLocalScore(artifact)) {
    artifact.scoreCalibration = calibrateScore({ verdict: artifact.verdict, confidence: artifact.confidence, personaPanel, plan, evidence, missingEvidence: artifact.missingEvidence });
    artifact.score = artifact.scoreCalibration.score;
  }
  const runMemory = recordPersonaRunMemory({ artifact, personaPanel, plan });
  artifact.runMemory = runMemory.ok ? { schemaVersion: runMemory.schemaVersion, aggregateSummary: runMemory.aggregateSummary } : { schemaVersion: runMemory.schemaVersion, status: 'skipped' };
  trace.push({ kind: 'run_memory', status: runMemory.ok ? 'ok' : 'limited', summary: runMemory.ok ? `${runMemory.aggregateSummary.totalRuns} aggregate runs` : runMemory.error });
  artifact.syntheticDigest = buildSyntheticDigest({ artifact, personaPanel, plan });
  trace.push({ kind: 'synthetic_digest', status: 'ok', summary: artifact.syntheticDigest.topBlocker });
  const sourcePersistence = await persistSourceBackedRun({ input, plan, evidence, toolResults, collectorPack, personaPanel, artifact, trace, preparedSource: sourceRoom });
  artifact.sourcePersistence = sourcePersistence.publicSummary;
  artifact.feedbackRunId = sourcePersistence.publicSummary?.runId || '';
  trace.push(sourcePersistence.trace);
  trace.push({ kind: 'specialists', status: 'ok', specialists: specialists.map((item) => item.name) });
  trace.push({ kind: 'critic', status: critique.confidence === 'low' ? 'limited' : 'ok', confidence: critique.confidence, missingEvidence: critique.missingEvidence });

  return {
    ok: true,
    reply: buildReply(artifact),
    artifact,
    trace,
  };
}






async function prepareSourceBackedRoom({ input = '', plan = {}, evidence = [], toolResults = [], collectorPack = null, maxPersonas = 10 } = {}) {
  const runId = `synthetic_run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  try {
    const store = createRuntimeSourceStore();
    const seed = await seedPersonasToSourceStore({ store, personas: PERSONA_BANK });
    const loaded = await loadPersonasFromSourceStore({ store, fallbackPersonas: PERSONA_BANK });
    const selectedIds = new Set(selectPersonaPanel({ input, plan, maxPersonas }).map((persona) => persona.id));
    const selectedPersonas = loaded.personas.filter((persona) => selectedIds.has(persona.id));
    const ingestion = await ingestEvidenceToSourceStore({ store, runId, input, plan, evidence, toolResults, collectorPack });
    const embeddings = await enrichRunEvidenceEmbeddings({ store, runId });
    const roleChecks = await executeRoleSpecificChecksToSourceStore({ store, runId, personas: selectedPersonas, plan, collectorPack, evidencePack: ingestion.rows, input });
    const sourceContext = sourceContextForSelectedPersonas({ store, personas: selectedPersonas, query: `${input} ${ingestion.rows.map((row) => row.text).join(' ')}`, limit: 6 });
    return { ok: true, store, runId, seed, loaded, selectedPersonas, ingestion, embeddings, roleChecks, sourceContext };
  } catch (error) {
    return { ok: false, runId, selectedPersonas: selectPersonaPanel({ input, plan, maxPersonas }), sourceContext: null, error };
  }
}

async function persistSourceBackedRun({ input = '', plan = {}, evidence = [], toolResults = [], collectorPack = null, personaPanel = null, artifact = {}, trace = [], preparedSource = null } = {}) {
  const runId = preparedSource?.runId || `synthetic_run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  try {
    const store = preparedSource?.store || createRuntimeSourceStore();
    const seed = preparedSource?.seed || await seedPersonasToSourceStore({ store, personas: PERSONA_BANK });
    const loaded = preparedSource?.loaded || await loadPersonasFromSourceStore({ store, fallbackPersonas: PERSONA_BANK });
    const ingestion = preparedSource?.ingestion || await ingestEvidenceToSourceStore({ store, runId, input, plan, evidence, toolResults, collectorPack });
    const roleChecks = preparedSource?.roleChecks || await executeRoleSpecificChecksToSourceStore({ store, runId, personas: loaded.personas, plan, collectorPack, evidencePack: ingestion.rows, input });
    const persistence = await persistSyntheticRunToSourceStore({ store, runId, input, plan, personaPanel, artifact, trace });
    const embeddingProvider = preparedSource?.embeddings?.provider || 'deterministic';
    return {
      ok: true,
      publicSummary: { schemaVersion: seed.schemaVersion, storage: store.storage, personaSource: loaded.source, runId, evidenceItems: ingestion.count + roleChecks.executed, votesPersisted: persistence.votesPersisted, roleToolExecutions: roleChecks.executed, embeddingProvider },
      trace: { kind: 'source_backed_db', status: 'ok', summary: `${ingestion.count + roleChecks.executed} evidence items, ${persistence.votesPersisted} votes persisted, ${roleChecks.executed} role checks, ${embeddingProvider} embeddings`, runId },
    };
  } catch (error) {
    return {
      ok: false,
      publicSummary: { schemaVersion: 'source-backed-db.v1', status: 'limited' },
      trace: { kind: 'source_backed_db', status: 'limited', summary: error?.message || 'source-backed persistence unavailable' },
    };
  }
}

function isOfficialSyntheticTokenInput(value = '') {
  return String(value || '').toLowerCase().includes(OFFICIAL_SYNTHETIC_CA);
}

function normalizeConversationReply({ reply = '', taskType = '', input = '' } = {}) {
  const clean = String(reply || '').trim();
  const inputText = String(input || '').toLowerCase();
  if (/\b(what skills|skills do you have|your skills|capabilities|what can you do|what do you do)\b/i.test(inputText)) {
    return buildSoulReply('capabilities', input);
  }
  if (/\b\d+\s+skills\b|skills in this session|autonomous-ai-agents|mlops|red-teaming|smart-home/i.test(clean)) {
    return buildSoulReply('capabilities', input);
  }
  if (taskType !== 'token_narrative_request') return clean;
  const lower = clean.toLowerCase();
  const userSuppliedUtility = /\b(access|governance|staking|utility|revenue share|burn|airdrop|tokenomics|dao|vote|yield|fee)\b/i.test(String(input || ''));
  const inventedUtility = /\b(access|governance|staking|utility|revenue share|burn|airdrop|dao|vote|yield|fee capture|trust primitive|proof-of-interest|participat(?:e|ion)|early users participate|validate(?:s|d)? trustworthy behavior|align(?:s|ment)? people and systems)\b/i.test(lower);
  if (!userSuppliedUtility && inventedUtility) return buildSoulReply(taskType, input);
  return clean;
}

function isConversationalTask(taskType) {
  return ['greeting', 'smalltalk', 'identity', 'capabilities', 'usage_help', 'project_knowledge', 'privacy_safety', 'general_question', 'miroshark_capability', 'bankr_launch_packet', 'product_info', 'audience_simulation', 'token_narrative_request'].includes(taskType);
}

function composeConversationArtifact({ plan }) {
  const bankrRail = plan.taskType === 'bankr_launch_packet' ? buildBankrLaunchRail(plan.input || '') : null;
  return {
    type: 'synthetic_user_agent_artifact',
    presentation: 'chat',
    runtime: AGENT_RUNTIME,
    taskType: plan.taskType,
    verdict: 'ready_to_help',
    confidence: 'high',
    goal: plan.goal,
    soul: plan.soul || null,
    whatLanded: ['Ask a question or paste a product surface. I will return a verdict, trust gaps, rewrite, evidence, and next actions.'],
    whatBrokeTrust: [],
    rewrite: { headline: 'Paste the thing you want pressure-tested.', cta: 'Ask or paste a URL/copy/brief' },
    comparison: null,
    sourceReport: null,
    bankrRail,
    disagreement: [],
    personaPanel: null,
    voteDistribution: null,
    objectionClusters: [],
    evidence: [],
    missingEvidence: [],
    nextActions: [
      'Paste a landing page URL, product brief, launch copy, onboarding flow, token CA, or two URLs to compare.',
      'Ask for a rewrite, trust-gap audit, before/after comparison, or launch pressure test.',
      'If you want a Shark Mode report, start with /shark and describe the surface.'
    ],
  };
}

function buildConversationReply(taskType, input = '') {
  return buildSoulReply(taskType, input);
}
function normalizeToolResult(result = {}) {
  return {
    ok: result.ok !== false,
    kind: result.kind || 'tool_result',
    summary: result.summary || '',
    evidence: Array.isArray(result.evidence) ? result.evidence : [],
    warnings: Array.isArray(result.warnings) ? result.warnings : [],
    artifact: result.artifact || null,
  };
}

function composeArtifact({ plan, evidence, specialists, critique, toolResults, personaPanel = null }) {
  const rewriteTool = toolResults.find((item) => item.kind === 'rewrite' || item.name === 'build_rewrite_actions');
  const memoTool = toolResults.find((item) => item.kind === 'synthetic_memo' || item.name === 'build_synthetic_memo');
  const comparisonTool = toolResults.find((item) => item.kind === 'surface_comparison' || item.name === 'compare_product_surfaces');
  const sourceReportTool = toolResults.find((item) => item.kind === 'miroshark_source_report' || item.name === 'attach_miroshark_source_report');
  const pageSurfaceTool = toolResults.find((item) => item.kind === 'page_surface' || item.name === 'collect_page_surface');
  const sourceEvidence = evidence.filter((item) => /^(external_skill|wake_|coral_|bankr_|aeon_)/i.test(item.kind || ''));
  const otherEvidence = evidence.filter((item) => !sourceEvidence.includes(item));
  const topEvidence = [...sourceEvidence, ...otherEvidence].slice(0, 12).map((item) => ({ kind: item.kind || 'evidence', text: item.text || item.summary || String(item).slice(0, 360) }));
  const externalSkillsUsed = formatExternalSkillsUsed(toolResults.flatMap((item) => item.externalSkillsUsed || item.artifact?.externalSkillsUsed || []));
  const skillEvidencePack = buildSkillEvidencePack({ toolResults, evidence, plan });
  const collectorPack = buildPersonaCollectorPack({ input: plan.input || '', evidence: [...evidence, ...(skillEvidencePack.personaEvidence || [])], toolResults, plan });
  const externalSourceDetails = externalSkillsUsed.length ? buildExternalSourceDetails({ toolResults, evidence, personaPanel, externalSkillsUsed, skillEvidencePack }) : [];
  const scoreCalibration = calibrateScore({ verdict: critique.verdict, confidence: critique.confidence, personaPanel, plan, evidence, missingEvidence: critique.missingEvidence });
  return {
    type: 'synthetic_user_agent_artifact',
    runtime: AGENT_RUNTIME,
    taskType: plan.taskType,
    publicTaskLabel: publicTaskLabel(plan.taskType),
    verdict: critique.verdict,
    publicVerdictLabel: publicVerdictLabel(critique.verdict, plan.taskType),
    confidence: critique.confidence,
    score: scoreCalibration.score,
    scoreCalibration,
    goal: plan.goal,
    soul: plan.soul || null,
    whatLanded: buildWhatLanded({ memoTool, personaPanel }),
    whatBrokeTrust: buildWhatBrokeTrust({ specialists, personaPanel }),
    rewrite: buildRewriteArtifact({ plan, input: plan.input || '', rewriteTool }),
    comparison: comparisonTool?.artifact || null,
    sourceReport: sourceReportTool?.artifact || null,
    surfaceEvidence: buildSurfaceEvidenceArtifact(pageSurfaceTool),
    tokenChart: buildTokenChartArtifact(toolResults),
    externalSkillsUsed,
    externalSourceDetails,
    skillEvidence: skillEvidencePack.used.length ? { schemaVersion: skillEvidencePack.schemaVersion, used: skillEvidencePack.used, reportEvidence: skillEvidencePack.reportEvidence, blocked: skillEvidencePack.blocked, attribution: skillEvidencePack.attribution } : null,
    collectorEvidence: collectorPack.collectorEvidence.length ? { schemaVersion: collectorPack.schemaVersion, summary: collectorPack.summary, evidence: collectorPack.collectorEvidence.slice(0, 8) } : null,
    syntheticCount: plan.syntheticCount || 10,
    disagreement: specialists.map((item) => ({ specialist: item.name, stance: item.stance, objection: item.objection, impact: item.impact })),
    personaPanel: personaPanel ? { totalLoaded: personaPanel.totalLoaded, selectedCount: personaPanel.selected.length, selected: personaPanel.selected, voteDistribution: personaPanel.voteDistribution, objectionClusters: personaPanel.objectionClusters, strongestSignals: personaPanel.strongestSignals, disagreementRound: personaPanel.disagreementRound, actionProbability: personaPanel.actionProbability, misunderstandingMap: personaPanel.misunderstandingMap, panelDigest: personaPanel.panelDigest, collectorEvidence: personaPanel.collectorEvidence, summary: personaPanel.summary } : null,
    voteDistribution: personaPanel?.voteDistribution || null,
    objectionClusters: personaPanel?.objectionClusters || [],
    actionProbability: personaPanel?.actionProbability || null,
    misunderstandingMap: personaPanel?.misunderstandingMap || null,
    panelDigest: personaPanel?.panelDigest || null,
    evidence: topEvidence,
    missingEvidence: critique.missingEvidence,
    nextActions: buildNextActions(plan, critique),
  };
}







function buildTokenChartArtifact(toolResults = []) {
  const tokenTool = toolResults.find((item) => item.kind === 'token_context' || item.name === 'collect_token_context');
  const market = tokenTool?.artifact?.market || null;
  const pairUrl = market?.pairUrl || null;
  if (!pairUrl || !/^https:\/\/dexscreener\.com\//i.test(pairUrl)) return null;
  const embedUrl = pairUrl.includes('?') ? `${pairUrl}&embed=1&theme=dark&trades=0&info=0` : `${pairUrl}?embed=1&theme=dark&trades=0&info=0`;
  return {
    provider: 'Dexscreener',
    title: 'Dexscreener chart',
    pairUrl,
    embedUrl,
    tokenName: market.baseToken?.name || null,
    tokenSymbol: market.baseToken?.symbol || null,
    tokenAddress: market.baseToken?.address || tokenTool?.artifact?.address || null,
    marketCapUsd: market.marketCapUsd ?? market.fdvUsd ?? null,
    liquidityUsd: market.liquidityUsd ?? null,
    volume24hUsd: market.volume24hUsd ?? null,
    priceChange24hPct: market.priceChange24hPct ?? null,
    websites: Array.isArray(market.websites) ? market.websites : [],
    socials: Array.isArray(market.socials) ? market.socials : [],
    xProfile: buildTokenXProfileSignal(market),
  };
}

function buildTokenXProfileSignal(market = {}) {
  const links = [...(Array.isArray(market.socials) ? market.socials : []), ...(Array.isArray(market.websites) ? market.websites : [])];
  const xLink = links.find((link) => {
    const url = String(link?.url || '');
    const type = String(link?.type || link?.label || '').toLowerCase();
    return /(twitter|x)/i.test(type) || /^https?:\/\/(?:www\.)?(?:x|twitter)\.com\//i.test(url);
  });
  if (!xLink?.url) return null;
  const handle = extractXHandle(xLink.url);
  return {
    url: xLink.url,
    handle,
    confidence: 'linked_source',
    source: 'Dexscreener token socials',
    summary: handle
      ? `Linked X profile @${handle} found in token social metadata. Treat as a narrative/account signal, not proof of safety.`
      : 'Linked X profile found in token social metadata. Treat as a narrative/account signal, not proof of safety.',
  };
}

function extractXHandle(url = '') {
  try {
    const parsed = new URL(url);
    if (!/(^|\.)(x|twitter)\.com$/i.test(parsed.hostname)) return '';
    const handle = parsed.pathname.split('/').filter(Boolean)[0] || '';
    if (/^(home|explore|search|notifications|messages|i|settings|compose|intent|share|hashtag)$/i.test(handle)) return '';
    return handle.replace(/^@/, '');
  } catch {
    return '';
  }
}

function buildWhatLanded({ memoTool = null, personaPanel = null } = {}) {
  const landed = [];
  if (personaPanel?.panelDigest?.verdict) landed.push(personaPanel.panelDigest.verdict);
  if (memoTool?.summary) landed.push(memoTool.summary);
  if (!landed.length) landed.push('The strongest path is the operator outcome: verdict, trust gaps, rewrite, evidence.');
  return unique(landed).slice(0, 3);
}

function buildWhatBrokeTrust({ specialists = [], personaPanel = null } = {}) {
  const panelRisks = [
    personaPanel?.panelDigest?.userExplanation,
    personaPanel?.disagreementRound?.resolution,
    ...((personaPanel?.objectionClusters || []).slice(0, 2).map((item) => `${item.label}: ${item.examples?.[0] || 'room objection'}`)),
  ].filter(Boolean);
  const specialistRisks = specialists
    .filter((item) => /gap|confidence|skeptical/i.test(`${item.impact} ${item.stance}`))
    .map((item) => item.objection)
    .filter(Boolean);
  return unique([...panelRisks, ...specialistRisks]).slice(0, 4);
}

function buildPanelTail(artifact = {}) {
  const action = artifact.actionProbability || artifact.personaPanel?.actionProbability;
  const misunderstanding = artifact.misunderstandingMap || artifact.personaPanel?.misunderstandingMap;
  const digest = artifact.panelDigest || artifact.personaPanel?.panelDigest;
  const parts = [];
  if (action) parts.push(`Synthetic action: try ${action.tryNow}% · bookmark ${action.bookmark}% · bounce ${action.bounce}% · BS ${action.callBs}%.`);
  if (misunderstanding?.gap) parts.push(`Misread: ${stripTrailingPunctuation(misunderstanding.gap)}.`);
  if (digest?.firstFix) parts.push(`First fix: ${stripTrailingPunctuation(digest.firstFix)}.`);
  return parts.length ? ` ${parts.join(' ')}` : '';
}


function buildExternalSourceDetails({ toolResults = [], evidence = [], personaPanel = null, externalSkillsUsed = [] } = {}) {
  const tokenTool = toolResults.find((item) => item.kind === 'token_context' || item.name === 'collect_token_context');
  const tokenArtifact = tokenTool?.artifact || {};
  const sources = [];
  const wake = tokenArtifact.wake;
  if (wake || externalSkillsUsed.some((name) => /wake/i.test(name))) {
    const breakdown = wake?.breakdown && typeof wake.breakdown === 'object'
      ? Object.entries(wake.breakdown).map(([key, value]) => `${key.replace(/_/g, ' ')}: ${value}`)
      : [];
    const links = wake?.links && typeof wake.links === 'object'
      ? Object.entries(wake.links).filter(([, value]) => typeof value === 'string' && /^https?:\/\//i.test(value)).map(([key, value]) => ({ label: key, url: value }))
      : [];
    sources.push({
      id: 'wake',
      title: 'WAKE Token Spotter',
      provider: 'WakeOnBase',
      attribution: 'WAKE Token Spotter Analysis by WakeOnBase',
      summary: 'Base-native token score, sub-scores, tags, security advisory, and analysis. Source signal only, not a buy/sell verdict.',
      score: wake?.score ?? wake?.total_score ?? null,
      tier: null,
      rows: [
        ...(wake?.tier || wake?.rating?.tier ? [{ label: 'Tier', value: wake?.tier || wake?.rating?.tier }] : []),
        ...(breakdown.length ? [{ label: 'Sub-scores', value: breakdown.join(' · ') }] : []),
        ...(Array.isArray(wake?.tags) && wake.tags.length ? [{ label: 'Tags', value: wake.tags.slice(0, 8).join(', ') }] : []),
        ...(wake?.security_advisory ? [{ label: 'Security advisory', value: [wake.security_advisory.level || 'unknown', ...(wake.security_advisory.reasons || []).slice(0, 3)].filter(Boolean).join(' - ') }] : []),
        ...(wake?.analysis ? [{ label: 'WAKE analysis', value: String(wake.analysis).replace(/\s+/g, ' ').slice(0, 900) }] : []),
      ],
      links,
    });
  }
  const coral = tokenArtifact.coral;
  if (coral || externalSkillsUsed.some((name) => /coral/i.test(name))) {
    const coralEvidence = evidence.filter((item) => /^coral_/i.test(item.kind || '')).map((item) => item.text || item.summary).filter(Boolean);
    sources.push({
      id: 'coral',
      title: 'Coral Community Intelligence',
      provider: '0xCoral',
      attribution: 'Coral Community Intelligence by 0xCoral',
      summary: 'Community, trending-token, registry, and caller context. Not a scam detector and not a trade signal.',
      rows: coralEvidence.slice(0, 8).map((text, index) => ({ label: coralRowLabel(text, index), value: text })),
      links: [{ label: 'Coral developers', url: 'https://www.0xcoral.com/developers' }],
    });
  }
  if (personaPanel) {
    const votes = personaPanel.voteDistribution?.percentages || personaPanel.voteDistribution || {};
    const voteLine = Object.entries(votes)
      .filter(([, value]) => typeof value === 'number' || typeof value === 'string')
      .map(([key, value]) => `${key}: ${value}%`).join(' · ');
    sources.push({
      id: 'synthetic-panel',
      title: 'Synthetic panel reaction',
      provider: 'Synthetic Users',
      attribution: 'Synthetic panel reaction',
      summary: personaPanel.summary || 'Simulated audience reaction based on the memo evidence.',
      rows: [
        ...(voteLine ? [{ label: 'Vote distribution', value: voteLine }] : []),
        ...((personaPanel.objectionClusters || []).slice(0, 4).map((item) => ({ label: item.label || 'Objection', value: `${item.count || 0} signal(s)${item.examples?.length ? ` - ${item.examples.slice(0, 2).join('; ')}` : ''}` }))),
        ...((personaPanel.strongestSignals || []).slice(0, 3).map((item) => ({ label: item.decision ? `${item.decision} signal` : 'Panel signal', value: `${item.personaName || item.personaId || 'Synthetic user'}: ${item.signal || item.evidence || item.text || item.summary || 'needs clearer proof path'}` }))),
      ],
      links: [],
    });
  }
  return sources;
}


function coralRowLabel(text = '', index = 0) {
  const value = String(text || '').toLowerCase();
  if (index === 0) return 'Community read';
  if (/registry/.test(value)) return 'Registry status';
  if (/trending tokens?/.test(value)) return 'Trending context';
  if (/leaderboard|caller|callers/.test(value)) return 'Caller context';
  return 'Community signal';
}

function buildSurfaceEvidenceArtifact(pageSurfaceTool = null) {
  const artifact = pageSurfaceTool?.artifact || {};
  const map = artifact.surfaceMap || null;
  const visual = artifact.visual || null;
  if (!map && !visual) return null;
  const pages = (map?.pages || [])
    .filter((page) => page?.url)
    .slice(0, 6)
    .map((page) => ({ url: page.url, title: page.title || page.url, ok: page.ok !== false }));
  const trust = map?.trustTaxonomy || null;
  return {
    kind: 'page_surface_evidence',
    summary: pageSurfaceTool?.summary || visual?.plainLanguageSummary || map?.summary || 'Page surface evidence collected.',
    screenshotUrl: visual?.heroCropUrl || visual?.screenshotUrl || null,
    fullScreenshotUrl: visual?.screenshotUrl || null,
    visual: visual ? {
      ok: visual.ok !== false,
      primaryHeading: visual.hierarchy?.primaryHeading || null,
      primaryCta: visual.hierarchy?.primaryCta || null,
      scores: visual.hierarchy?.scores || null,
      foldMap: visual.foldMap ? {
        heroHasPrimaryCta: Boolean(visual.foldMap.heroHasPrimaryCta),
        heroHasTrustProof: Boolean(visual.foldMap.heroHasTrustProof),
        ctaChoicesAboveFold: visual.foldMap.ctaChoicesAboveFold ?? null,
      } : null,
      fixes: (visual.visualFixes || []).slice(0, 4),
    } : null,
    map: map ? {
      checkedPages: pages,
      proofDepth: map.proofDepth ? {
        homeStrongProofCount: map.proofDepth.homeStrongProofCount || 0,
        hiddenProofPages: (map.proofDepth.hiddenProofPages || []).length,
      } : null,
      trustScore: trust?.score ?? null,
      trustAnchorsFound: trust?.trustAnchorsFound || [],
      trustGaps: trust?.trustGaps || [],
      topActions: (trust?.topActions || []).slice(0, 4),
    } : null,
  };
}

function compactList(items = [], limit = 4) {
  return [...new Set((items || []).map((item) => String(item || '').trim()).filter(Boolean))].slice(0, limit);
}

function compactEvidence(items = [], limit = 8) {
  return (items || [])
    .map((item) => typeof item === 'object' ? { kind: item.kind || 'evidence', text: String(item.text || item.summary || '').trim() } : { kind: 'evidence', text: String(item || '').trim() })
    .filter((item) => item.text)
    .slice(0, limit);
}

function composeMarketForecastArtifact({ plan, evidence = [], toolResults = [], personaPanel = null } = {}) {
  const openWorldTool = toolResults.find((item) => item.kind === 'open_world_evidence' || item.name === 'collect_open_world_evidence');
  const signals = (evidence || []).map((item) => String(item.text || item.summary || item || '').trim()).filter(Boolean);
  const summary = openWorldTool?.summary || signals[0] || 'Directional market read only; live evidence is thin.';
  const base = inferMarketBaseCase(summary, signals, plan.input || '');
  const topRisks = compactList([
    ...signals.filter((line) => /risk|volatile|macro|liquid|bear|down|uncertain|flip|rate|headline/i.test(line)),
    'Market forecasts are probabilistic; liquidity and macro headlines can invalidate the read fast.',
  ], 4);
  const drivers = compactList([
    ...signals.filter((line) => /btc|bitcoin|eth|liquidity|alt|catalyst|macro|flow|rotation|risk/i.test(line)),
    summary,
  ], 5);
  return {
    type: 'synthetic_user_agent_artifact',
    runtime: AGENT_RUNTIME,
    presentation: 'answer',
    taskType: 'market_forecast',
    verdict: 'use_as_directional_read',
    confidence: signals.length >= 3 ? 'medium' : 'limited',
    score: signals.length >= 3 ? 64 : 54,
    goal: plan.goal,
    answer: base.answer,
    scenarios: base.scenarios,
    whatLanded: [summary],
    whatBrokeTrust: topRisks,
    rewrite: { headline: 'Track liquidity first, then catalysts.', cta: 'Rerun with timeframe, assets, and risk tolerance' },
    comparison: null,
    sourceReport: openWorldTool?.artifact?.sourceReport || null,
    syntheticCount: plan.syntheticCount || 10,
    disagreement: [],
    personaPanel: personaPanel ? { totalLoaded: personaPanel.totalLoaded, selectedCount: personaPanel.selected.length, voteDistribution: personaPanel.voteDistribution, objectionClusters: personaPanel.objectionClusters, strongestSignals: personaPanel.strongestSignals, disagreementRound: personaPanel.disagreementRound, actionProbability: personaPanel.actionProbability, misunderstandingMap: personaPanel.misunderstandingMap, panelDigest: personaPanel.panelDigest, summary: personaPanel.summary } : null,
    voteDistribution: personaPanel?.voteDistribution || null,
    objectionClusters: personaPanel?.objectionClusters || [],
    evidence: compactEvidence((evidence || []).map((item) => ({ kind: item.kind || 'market_signal', text: item.text || item.summary || String(item) })), 8),
    missingEvidence: ['Exact timeframe', 'Assets/universe: BTC, ETH, majors, meme coins, or portfolio', 'Risk tolerance and whether this is trade, hold, or product timing'].filter((_, index) => String(plan.input || '').split(/\s+/).length < 18 || index < 1),
    nextActions: ['Specify timeframe and asset universe.', 'Separate base case from invalidation trigger.', 'Use MiroShark/Shark only when you want a deeper paid source report.'],
  };
}

function inferMarketBaseCase(summary = '', signals = [], input = '') {
  const text = [summary, ...signals, input].join(' ').toLowerCase();
  const bearish = /bear|down|sell|risk-off|crash|tighten|weak|drop/.test(text);
  const bullish = /bull|up|risk-on|bid|rally|liquidity|rotation/.test(text);
  const answer = bullish && !bearish ? 'Moderately bullish, but liquidity-led.' : bearish && !bullish ? 'Defensive / bearish until liquidity improves.' : 'Choppy, selective, and liquidity-sensitive.';
  return {
    answer,
    scenarios: [
      { label: 'Base case', probability: 55, text: answer.includes('Choppy') ? 'BTC/majors lead, alts rotate only around strong catalysts, volatility stays high.' : answer },
      { label: 'Bull case', probability: 25, text: 'Liquidity improves, BTC confirms direction, and high-beta tokens catch rotation.' },
      { label: 'Bear case', probability: 20, text: 'Macro/rates/headline risk pulls liquidity out and weak alts sell first.' },
    ],
  };
}

function buildMarketForecastReply(artifact = {}) {
  const scenarios = artifact.scenarios || [];
  const line = (label) => scenarios.find((item) => item.label === label)?.text || '';
  const confidence = artifact.confidence || 'limited';
  const drivers = (artifact.evidence || [])
    .map((item) => item.text)
    .filter(Boolean)
    .filter((text) => !/hidden panel|synthetic users?|confused|would_try|reject|first[- ]action|convert/i.test(text))
    .slice(0, 3);
  const risks = (artifact.whatBrokeTrust || []).slice(0, 2);
  return [
    `Answer: ${artifact.answer || 'Choppy, selective, and liquidity-sensitive.'}`,
    `Base case: ${line('Base case') || 'BTC/majors lead; weaker alts need catalysts.'}`,
    `Bull case: ${line('Bull case') || 'Liquidity improves and high-beta crypto catches rotation.'}`,
    `Bear case: ${line('Bear case') || 'Macro or liquidity shock hits alts first.'}`,
    `Drivers: ${drivers.length ? drivers.join(' / ') : 'liquidity, BTC direction, macro risk, and catalyst quality.'}`,
    `Confidence: ${confidence}. This is a modeled forecast, not financial advice.`,
    risks.length ? `Watch: ${risks.join(' / ')}` : '',
  ].filter(Boolean).join('\n');
}

function buildBankrLaunchRail(input = '') {
  const text = String(input || '');
  const nameMatch = text.match(/(?:token\s+named|token\s+name|called|named|name)\s+([A-Za-z0-9][A-Za-z0-9 _-]{1,32})/i);
  const name = (nameMatch?.[1] || '').replace(/\s+ticker.*$/i, '').trim();
  const ticker = (text.match(/(?:ticker|symbol)\s+\$?([A-Za-z0-9]{2,12})/i)?.[1] || '').toUpperCase();
  return {
    status: 'locked_until_confirmation',
    execution: 'disabled_until_launch_now',
    chain: 'Base',
    name: name || null,
    ticker: ticker || null,
    confirmations: [
      'token name, ticker, description, and image/logo locked',
      'signer identity selected',
      'creator-fee recipient selected',
      'launch identity selected; Synthetic X is off unless explicitly selected',
      'separate Launch now confirmation received',
    ],
    nextStep: 'Prepare launch packet, then require signer/fee/identity confirmation before Bankr execution.',
  };
}

function buildNextActions(plan, critique) {
  if (critique.verdict === 'need_more_context') return ['Paste the actual page, launch copy, onboarding flow, token CA, or product brief.', 'Name the audience and what decision you want the agent to make.'];
  const actions = ['Rewrite the highest-risk claim first.', 'Add visible proof before asking for action.', 'Rerun the agent after the rewrite and compare before/after.'];
  if (plan.taskType === 'comparison') actions.unshift('Use the comparison verdict; ship only if the after version has no critical CTA/proof regression.');
  if (plan.taskType === 'token_launch') actions.unshift('State the current holder reason and market-cap path in plain language.');
  if (plan.taskType === 'x_profile_review') actions.unshift('Rewrite bio + pinned post around proof, current progress, and why to follow now.');
  if (plan.taskType === 'page_review') actions.unshift('Put proof, demo/docs/pricing path, and CTA above the fold.');
  return actions.slice(0, 4);
}

function publicTaskLabel(taskType = '') {
  const labels = {
    token_launch: 'token review',
    page_review: 'page review',
    x_profile_review: 'X profile review',
    narrative_rewrite: 'narrative review',
    brief_review: 'brief review',
    comparison: 'comparison',
    market_forecast: 'market forecast',
    external_source_research: 'source research',
  };
  return labels[taskType] || String(taskType || 'pressure test').replace(/_/g, ' ');
}

function publicVerdictLabel(verdict = '', taskType = '') {
  if (verdict === 'ship') return taskType === 'token_launch' ? 'holder thesis is usable' : 'usable with proof';
  if (verdict === 'rewrite_before_launch') {
    if (taskType === 'x_profile_review') return 'profile needs a proof-first rewrite';
    if (taskType === 'token_launch') return 'holder thesis needs more proof';
    if (taskType === 'page_review') return 'landing needs a first-fold rewrite';
    return 'rewrite before launch';
  }
  if (verdict === 'use_as_directional_read') return 'directional read only';
  return String(verdict || 'needs review').replace(/_/g, ' ');
}


function describeTokenExternalSkills(skills = []) {
  const names = skills.join(' || ');
  const notes = [];
  if (/WAKE Token Spotter Analysis/i.test(names)) notes.push('WAKE = Base token spotter score, sub-scores, tags, and security advisory');
  if (/Coral Community Intelligence/i.test(names)) notes.push('Coral = community momentum, trending-token context, and registry/caller signal; not a scam verdict');
  return notes.length ? `${notes.join('; ')}.` : 'external source signal was attached with attribution.';
}

function buildReply(artifact) {
  if (artifact.verdict === 'need_more_context') return buildMissingContextReply({ taskType: artifact.taskType, missingContext: artifact.missingEvidence });
  if (artifact.sourceReport && artifact.sourceReport.synthesis) {
    const answer = artifact.sourceReport.synthesis.answer || artifact.sourceReport.synthesis.summary || 'Read the source report below.';
    return `Shark Mode answer: ${stripTrailingPunctuation(answer)}`;
  }
  if (artifact.sourceReport && (artifact.sourceReport.waitUrl || artifact.sourceReport.trackingUrl || artifact.sourceReport.status || artifact.sourceReport.progress)) {
    return 'Shark Mode simulation queued. I sent the exact question to MiroShark; the report is running now.';
  }
  if (artifact.taskType === 'market_forecast') return buildMarketForecastReply(artifact);
  const score = Number.isFinite(artifact.score) ? `${artifact.score}/100` : scoreArtifact(artifact) + '/100';
  const publicVerdict = publicVerdictLabel(artifact.verdict, artifact.taskType);
  if (artifact.comparison) {
    return `Comparison: ${artifact.comparison.verdict?.label || publicVerdict}. Score: ${score}. Delta: ${artifact.comparison.scoreDelta?.total ?? 0}. Fix: ${artifact.nextActions[0] || 'inspect tradeoffs'}`;
  }
  return buildDigestReply(artifact);
}

function buildDigestReply(artifact = {}) {
  const digest = artifact.syntheticDigest || buildSyntheticDigest({ artifact });
  const label = artifact.taskType === 'page_review' ? 'Landing review'
    : artifact.taskType === 'x_profile_review' ? 'X profile review'
    : artifact.taskType === 'token_launch' ? 'Token review'
    : artifact.taskType === 'narrative_rewrite' ? 'Rewrite review'
    : 'Review';
  const evidence = digest.evidenceQuality?.level ? `Evidence: ${digest.evidenceQuality.level} - ${stripTrailingPunctuation(digest.evidenceQuality.reason)}.` : '';
  const context = artifact.taskType === 'token_launch' && isOfficialSyntheticTokenInput(artifact.goal || '') ? ' Project token context: official Base CA recognized.' : '';
  return `${label}: ${digest.scoreLine}.${context} Top blocker: ${stripTrailingPunctuation(digest.topBlocker)}. Room: ${stripTrailingPunctuation(digest.roomSplit)}. ${evidence} Fastest mover: ${stripTrailingPunctuation(digest.fastestVoteMover)}. First fix: ${stripTrailingPunctuation(digest.firstFix)}. Why it matters: ${stripTrailingPunctuation(digest.whyItMatters)}.`;
}

function unique(items = []) {
  return [...new Set(items.filter(Boolean))];
}

function stripTrailingPunctuation(value = '') {
  return String(value || '').trim().replace(/[.。]+$/g, '');
}

function buildRewriteArtifact({ plan, input = '', rewriteTool = null } = {}) {
  if (rewriteTool?.artifact) return rewriteTool.artifact;
  if (plan?.taskType === 'x_profile_review') return { headline: 'Make the bio prove the product in one line, then pin the strongest live result.', cta: 'Post one concrete proof thread' };
  if (plan?.taskType === 'narrative_rewrite') {
    const source = extractRewriteSource(input);
    const concreteSubject = source.replace(/^(rewrite this|make this|sharpen this)[:\s-]*/i, '').trim();
    const headline = concreteSubject
      ? `${concreteSubject.replace(/\.$/, '')}: find the trust gap before launch.`
      : 'Lead with the buyer outcome, then attach proof.';
    return { headline: headline.slice(0, 180), cta: 'Pressure-test the rewrite' };
  }
  return { headline: 'Make the claim concrete, then show proof.', cta: 'Run preflight' };
}

function extractRewriteSource(input = '') {
  const text = String(input || '').trim();
  const colon = text.match(/(?:rewrite this|sharpen this|make this[^:]{0,80})\s*:\s*(.+)$/i);
  if (colon?.[1]) return colon[1].trim();
  const quoted = text.match(/[“"]([^”"]{18,})[”"]/);
  if (quoted?.[1]) return quoted[1].trim();
  return text;
}

function buildMissingContextReply(plan = {}) {
  if (plan.taskType === 'narrative_rewrite') return 'Paste the actual narrative, launch copy, headline, or page you want rewritten. Then I can give you a real verdict, trust break, sharper version, and next fix.';
  return 'I need the actual surface before I can judge it: paste the page, launch copy, onboarding flow, token CA, or product brief.';
}

function shouldRecomputeLocalScore(artifact = {}) {
  if (!artifact || artifact.taskType === 'market_forecast') return false;
  if (artifact.comparison) return false;
  if (artifact.sourceReport?.kind === 'hermes_source_synthesis') return false;
  return ['page_review', 'x_profile_review', 'token_launch', 'narrative_rewrite', 'brief_review'].includes(artifact.taskType);
}

function scoreArtifact({ verdict = '', confidence = '', personaPanel = null, plan = {}, evidence = [], missingEvidence = [] } = {}) {
  return calibrateScore({ verdict, confidence, personaPanel, plan, evidence, missingEvidence }).score;
}
