import { runSyntheticUserAgentTurn } from './agent-runner.js';
import { normalizeSyntheticCount } from '../source-report-synthesis.js';

export async function handleCreateAgentSession({ store, body }) {
  const input = String(body?.input || '').trim();
  const userId = String(body?.userId || 'anon').trim() || 'anon';
  const session = await store.create({ input, userId });
  return { ok: true, session: publicAgentSession(session) };
}

const ALLOWED_AGENT_MODELS = new Set(['gpt-5.3-codex-spark', 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free', 'poolside/laguna-xs.2:free', 'moonshotai/kimi-k2.6:free', 'nvidia/nemotron-3-super-120b-a12b:free', 'qwen/qwen3-coder:free', 'z-ai/glm-4.5-air:free', 'meta-llama/llama-3.3-70b-instruct:free', 'nousresearch/hermes-3-llama-3.1-405b:free']);

const sessionMessageQueues = new Map();
const DEFAULT_AGENT_TURN_TIMEOUT_MS = Number(process.env.SYNTHETIC_AGENT_TURN_TIMEOUT_MS || 150000);

class AgentTurnTimeoutError extends Error {
  constructor(timeoutMs) {
    super(`Agent turn timed out after ${Math.round(timeoutMs / 1000)}s`);
    this.name = 'AgentTurnTimeoutError';
    this.code = 'agent_turn_timeout';
    this.timeoutMs = timeoutMs;
  }
}

function runWithTimeout(promise, timeoutMs = DEFAULT_AGENT_TURN_TIMEOUT_MS) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new AgentTurnTimeoutError(timeoutMs)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => { if (timer) clearTimeout(timer); });
}

export async function handleAgentMessage({ store, id, body, runnerOptions = {} }) {
  const key = String(id || '');
  const previous = sessionMessageQueues.get(key) || Promise.resolve();
  const run = previous.catch(() => {}).then(() => handleAgentMessageNow({ store, id, body, runnerOptions }));
  sessionMessageQueues.set(key, run.finally(() => {
    if (sessionMessageQueues.get(key) === run) sessionMessageQueues.delete(key);
  }));
  return run;
}

async function handleAgentMessageNow({ store, id, body, runnerOptions = {} }) {
  const content = String(body?.message || body?.input || '').trim();
  const abortSignal = runnerOptions.abortSignal || body?.abortSignal || null;
  if (!content) return { status: 400, payload: { ok: false, error: 'Agent message is required' } };
  if (abortSignal?.aborted) return { status: 499, payload: { ok: false, error: 'Request was cancelled before the run started.', code: 'client_cancelled' } };
  const userId = String(body?.userId || '').trim();
  let session = await store.get(id, userId ? { userId } : {});
  if (!session) return { status: 404, payload: { ok: false, error: 'Agent session not found' } };
  const priorSession = session;
  const deepSourceRequested = shouldRunDeepSourcePass(content, body);
  const sourcePromptPlan = deepSourceRequested ? buildDeepSourceInput({ content, session: priorSession, explicitPrompt: body?.deepSourcePass === true || /^\/shark\b/i.test(content) }) : { ok: true, prompt: content };
  session = await store.appendMessage(id, { role: 'user', content });
  if (abortSignal?.aborted) {
    session = await store.update(id, { status: 'aborted', workingMemory: { ...(session.workingMemory || {}), summary: 'Run cancelled before execution.', lastUserGoal: content } });
    return { status: 499, payload: { ok: false, error: 'Request was cancelled before execution.', code: 'client_cancelled', session: publicAgentSession(session) } };
  }
  if (deepSourceRequested && sourcePromptPlan.ok === false) {
    const clarification = buildSourcePromptClarification(content, sourcePromptPlan);
    session = await store.appendMessage(id, { role: 'assistant', content: clarification.reply, artifact: clarification.artifact });
    session = await store.update(id, { status: 'idle', artifact: clarification.artifact, workingMemory: { ...(session.workingMemory || {}), summary: clarification.reply.slice(0, 260), lastUserGoal: content } });
    return { status: 200, payload: { ok: true, result: publicAgentResult(clarification), session: publicAgentSession(session) } };
  }
  const agentInput = sourcePromptPlan.prompt || content;
  session = await store.update(id, { status: 'running' });
  const selectedModel = String(body?.model || body?.modelPreference || '').trim();
  const syntheticCount = normalizeSyntheticCount(body?.syntheticCount || body?.maxSynthetics || 10);
  const hermesOptions = { ...(runnerOptions.hermesOptions || {}) };
  if (selectedModel && ALLOWED_AGENT_MODELS.has(selectedModel) && !/\s-m\s|--model/.test(` ${hermesOptions.command || ''} `)) {
    const baseCommand = hermesOptions.command || '/root/.local/bin/synthetic-agent chat -Q -t safe -q';
    if (selectedModel === 'gpt-5.3-codex-spark') {
      hermesOptions.command = baseCommand;
    } else {
      const modelFlags = `--provider openrouter -m ${JSON.stringify(selectedModel)}`;
      hermesOptions.command = baseCommand.includes(' -q')
        ? baseCommand.replace(' -q', ` ${modelFlags} -q`)
        : `${baseCommand} ${modelFlags}`;
    }
  }
  let result;
  try {
    result = await runWithTimeout(runSyntheticUserAgentTurn({
      input: agentInput,
      history: session.messages || [],
      allowPaidMiroShark: deepSourceRequested,
      toolOptions: { ...(runnerOptions.toolOptions || {}), syntheticCount },
      useHermesBrain: runnerOptions.useHermesBrain === true,
      hermesOptions,
      syntheticCount,
    }), runnerOptions.turnTimeoutMs);
  } catch (error) {
    const timedOut = error?.code === 'agent_turn_timeout' || error?.name === 'AgentTurnTimeoutError';
    const message = timedOut
      ? 'This run took too long and was stopped. Try a narrower URL/source pass, or ask the next question.'
      : 'This run failed before Synthetic could write the answer. Try once more or narrow the source pass.';
    const artifact = {
      taskType: 'run_error',
      presentation: 'chat',
      verdict: 'need_more_context',
      publicTaskLabel: 'run interrupted',
      publicVerdictLabel: timedOut ? 'source timeout' : 'run failed',
      errorCode: timedOut ? 'agent_turn_timeout' : 'agent_turn_failed',
    };
    session = await store.appendMessage(id, { role: 'assistant', content: message, artifact, trace: [{ type: 'error', code: artifact.errorCode, message: String(error?.message || error) }] });
    session = await store.update(id, { status: 'idle', artifact, workingMemory: { ...(session.workingMemory || {}), summary: message, lastUserGoal: content } });
    return { status: timedOut ? 504 : 500, payload: { ok: false, error: message, code: artifact.errorCode, result: { ok: false, reply: message, artifact }, session: publicAgentSession(session) } };
  }
  const finalResult = normalizeDeepSourceResult({ result, deepSourceRequested });
  if (abortSignal?.aborted) {
    session = await store.update(id, { status: 'aborted', trace: finalResult.trace, artifact: null, workingMemory: { ...(session.workingMemory || {}), summary: 'Run cancelled before response delivery.', lastUserGoal: content } });
    return { status: 499, payload: { ok: false, error: 'Request was cancelled before response delivery.', code: 'client_cancelled', session: publicAgentSession(session) } };
  }
  session = await store.appendMessage(id, { role: 'assistant', content: finalResult.reply, artifact: finalResult.artifact, trace: finalResult.trace });
  session = await store.update(id, { status: 'idle', trace: finalResult.trace, artifact: finalResult.artifact, workingMemory: { ...(session.workingMemory || {}), evidenceCount: finalResult.artifact.evidence?.length || 0, summary: finalResult.reply.slice(0, 260), lastUserGoal: content } });
  return { status: 200, payload: { ok: true, result: publicAgentResult(finalResult), session: publicAgentSession(session) } };
}


function normalizeDeepSourceResult({ result = {}, deepSourceRequested = false } = {}) {
  if (!deepSourceRequested || !result?.artifact?.sourceReport) return result;
  const sourceReport = result.artifact.sourceReport || {};
  const synthesis = sourceReport.synthesis || sourceReport.syntheticSynthesis || null;
  const reply = synthesis?.answer
    ? `Shark Mode answer: ${stripTrailingPunctuation(synthesis.answer)}`
    : 'Shark Mode simulation queued. I sent the exact question to MiroShark; the report is running now.';
  return { ...result, reply };
}

function stripTrailingPunctuation(value = '') {
  return String(value || '').trim().replace(/[.。]+$/g, '');
}

function shouldRunDeepSourcePass(content = '', body = {}) {
  if (body?.deepSourcePass === true) return true;
  const text = String(content || '').trim().toLowerCase();
  return /^\/shark\b|deep\s+(source|simulation|report|pass)|original\s+report|source\s+report|(?:run|start|launch|execute|send|route|process)\s+(?:this\s+|it\s+|the\s+simulation\s+)?(?:through|via|on|with)\s+(?:miro\s*shark|miroshark)|(?:through|via)\s+(?:miro\s*shark|miroshark)/i.test(text);
}

function buildDeepSourceInput({ content = '', session = {}, explicitPrompt = false } = {}) {
  const raw = String(content || '').trim();
  if (explicitPrompt && raw.length >= 4) return { ok: true, prompt: shapeMiroSharkSourcePrompt(raw.replace(/^\/shark\b[:\s-]*/i, '')) };
  const previous = [...(session.messages || [])]
    .reverse()
    .find((msg) => msg?.role === 'user' && String(msg?.content || '').trim().length >= 20 && !shouldRunDeepSourcePass(String(msg?.content || ''), {}));
  const previousContext = previous?.content ? String(previous.content).slice(0, 1800) : '';
  const hasOwnSurface = /https?:\/\/|0x[a-fA-F0-9]{40}|\n|:|launch|product|page|copy|market|audience|base|simulation|simulate/i.test(raw) && raw.split(/\s+/).length >= 7;
  const source = hasOwnSurface ? raw : previousContext;
  if (!source || source.split(/\s+/).length < 7) return { ok: false, reason: 'missing_context', raw };
  return { ok: true, prompt: shapeMiroSharkSourcePrompt(source) };
}

function shapeMiroSharkSourcePrompt(source = '') {
  const question = sanitizePublicAgentText(source).slice(0, 2600).trim();
  if (!question) return '';
  if (isSportsFinalistsQuestion(question)) return shapeSportsFinalistsPrompt(question);
  if (isSportsWinnerQuestion(question)) return shapeSportsWinnerPrompt(question);
  return [
    'Answer the user question below. Keep the same intent; do not convert it into a generic product review.',
    '',
    `User question: ${question}`,
    '',
    'Required behavior:',
    '- Treat the user question as the main task.',
    '- If it asks who wins, the report must stay on the winner question. Do not replace it with an injury, weather, logistics, or proxy market unless that proxy directly resolves the winner.',
    '- For sports winner questions, evaluate likely winner candidates, uncertainty, decisive evidence, and what would change the call.',
    '- If there is not enough evidence to name a winner, say no clear call and explain what evidence is missing.',
    '- If it asks for a product/token/community reaction, simulate that exact audience and decision.',
    '- Do not answer a different question.',
    '- Separate real evidence, inferred claims, and simulated reactions.',
    '- End with a concise direct answer that Hermes can adapt into one user-facing sentence.'
  ].join('\n').slice(0, 3900);
}

function isSportsFinalistsQuestion(question = '') {
  const text = String(question || '').toLowerCase();
  return /\b(reach|make|advance|get)\s+(?:to\s+)?(?:the\s+)?finals?\b|\bfinalists?\b|\bfinal\s+two\b/i.test(text)
    && /\b(world\s+cup|football|soccer|tournament|cup|league|knockout)\b/i.test(text);
}

function shapeSportsFinalistsPrompt(question = '') {
  return [
    'Resolve the exact sports finalists question only.',
    '',
    `Exact user question: ${question}`,
    '',
    'Hard constraints:',
    '- The simulation target is which teams reach the final match, not who wins the tournament.',
    '- Required report title must include the phrase: 2026 FIFA World Cup finalists.',
    '- Required market question must be about which two national teams are most likely to reach the 2026 FIFA World Cup final.',
    '- Compare likely finalist candidates, bracket-path uncertainty, squad quality, recent form, draw variance, and what would change the call.',
    '- Forbidden proxy tasks: injuries, heat, host logistics, substitutions, fatigue-only markets, player duels, single-match incidents, or generic tournament operations unless directly tied to finalist probability.',
    '- If evidence is too weak, say no clear call and explain which evidence is missing.',
    '- End with one direct answer naming the best finalist pair or saying no clear pair.',
    '- Do not answer a different question.'
  ].join('\n').slice(0, 3900);
}

function isSportsWinnerQuestion(question = '') {
  const text = String(question || '').toLowerCase();
  return /\b(who\s+will\s+win|winner|champion|take\s+the\s+title|wins?\s+the)\b/i.test(text)
    && /\b(world\s+cup|football|soccer|tournament|cup|league|final)\b/i.test(text);
}

function shapeSportsWinnerPrompt(question = '') {
  return [
    'Resolve the exact sports winner question only.',
    '',
    `Exact user question: ${question}`,
    '',
    'Hard constraints:',
    '- The simulation target is the tournament winner, not a proxy scenario.',
    '- Required report title must include the phrase: 2026 FIFA World Cup winner.',
    '- Required market question must be about which national team is most likely to win the 2026 FIFA World Cup.',
    '- Compare likely winner candidates, uncertainty, decisive evidence, and what would change the call.',
    '- If evidence is insufficient, say no clear call instead of inventing a proxy market.',
    '- Forbidden proxy tasks: penalty shootouts, individual player duels, injuries, heat, weather, host logistics, substitutions, squad recovery, or one-match incidents unless they directly decide the tournament winner.',
    '- End with a concise direct answer that Hermes can adapt into one user-facing sentence.'
  ].join('\n').slice(0, 3900);
}

function buildSourcePromptClarification(content = '', plan = {}) {
  const options = [
    'Simulate Base-native reaction to a new AI product launch: audience sees the landing page, one demo output, and a short token/launch announcement. Return trust breaks, likely objections, and proof needed.',
    'Simulate skeptical crypto builders reviewing this AI product before launch. Focus on differentiation, first-run UX, proof, and whether they would share it.',
    'Simulate traders and early Base users reacting to this AI product launch. Focus on hype vs real utility, trust risk, and what would make them try it.'
  ];
  const reply = 'I need a bit more context before sending this to MiroShark. Add the product surface or pick one of these source-report prompts.';
  return {
    ok: true,
    reply,
    artifact: {
      type: 'synthetic_user_agent_artifact',
      taskType: 'source_report_clarification',
      presentation: 'chat',
      verdict: 'need_more_context',
      confidence: 'high',
      suggestedPrompts: options,
      missingEvidence: ['Product name or page', 'Audience/user segment', 'What the audience sees', 'Decision you want simulated'],
      nextActions: ['Paste the launch page/copy, or click one suggested prompt and add the product name.'],
    },
  };
}

function publicAgentResult(result = {}) {
  const artifact = publicArtifact(result.artifact || null);
  return {
    ok: result.ok !== false,
    reply: result.reply || '',
    artifact,
  };
}

function publicArtifact(artifact) {
  if (!artifact) return null;
  const safe = {};
  const copyScalar = (key) => {
    const value = artifact[key];
    if (value == null) return;
    if (typeof value === 'string') safe[key] = sanitizePublicAgentText(value);
    else if (typeof value === 'number' || typeof value === 'boolean') safe[key] = value;
  };

  for (const key of [
    'taskType',
    'status',
    'mode',
    'intent',
    'depth',
    'score',
    'confidence',
    'verdict',
    'publicVerdictLabel',
    'agenticTaskLabel',
    'classification',
    'kind',
    'syntheticCount',
    'feedbackRunId',
  ]) copyScalar(key);

  if (artifact.goal) safe.goal = compactPublicAgentText(artifact.goal);
  if (artifact.summary) safe.summary = compactPublicAgentText(artifact.summary);
  if (artifact.syntheticDigest) safe.syntheticDigest = publicSyntheticDigest(artifact.syntheticDigest);
  if (Array.isArray(artifact.evidence)) safe.evidence = publicEvidence(artifact.evidence);
  if (Array.isArray(artifact.missingEvidence)) safe.missingEvidence = artifact.missingEvidence.map(compactPublicAgentText).filter(Boolean).slice(0, 6);
  if (Array.isArray(artifact.nextActions)) safe.nextActions = artifact.nextActions.map(compactPublicAgentText).filter(Boolean).slice(0, 8);
  if (Array.isArray(artifact.suggestedPrompts)) safe.suggestedPrompts = artifact.suggestedPrompts.map(compactPublicAgentText).filter(Boolean).slice(0, 8);
  if (Array.isArray(artifact.externalSkillsUsed)) safe.externalSkillsUsed = artifact.externalSkillsUsed.slice(0, 8);
  if (Array.isArray(artifact.externalSourceDetails)) safe.externalSourceDetails = artifact.externalSourceDetails.map(publicExternalSource).filter(Boolean).slice(0, 8);
  if (artifact.sourceReport != null) {
    safe.sourceReport = publicSourceReport(artifact.sourceReport);
    if (safe.sourceReport && safe.sourceReport.syntheticCount == null && typeof artifact.syntheticCount === 'number') safe.sourceReport.syntheticCount = artifact.syntheticCount;
  }
  if (artifact.comparison) safe.comparison = publicJsonSubset(artifact.comparison, 12000);
  if (artifact.surfaceEvidence) safe.surfaceEvidence = publicJsonSubset(artifact.surfaceEvidence, 12000);
  if (artifact.tokenChart) safe.tokenChart = publicJsonSubset(artifact.tokenChart, 4000);
  if (artifact.share) safe.share = publicJsonSubset(artifact.share, 4000);
  if (artifact.source) safe.source = publicJsonSubset(artifact.source, 4000);
  if (artifact.runtime) safe.runtime = { name: 'SyntheticAI terminal', hostedLlm: Boolean(artifact.runtime.hostedLlm) };
  return stripUndefined(safe);
}

function stripUndefined(value) {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(stripUndefined).filter((item) => item !== undefined);
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined).map(([k, v]) => [k, stripUndefined(v)]));
}

function publicSyntheticDigest(digest = {}) {
  const evidenceQuality = digest.evidenceQuality && typeof digest.evidenceQuality === 'object'
    ? {
      level: compactPublicAgentText(digest.evidenceQuality.level || ''),
      reason: compactPublicAgentText(digest.evidenceQuality.reason || ''),
    }
    : undefined;
  return stripUndefined({
    schemaVersion: digest.schemaVersion === 'synthetic-digest.v1' ? digest.schemaVersion : 'synthetic-digest.v1',
    mainRead: compactPublicAgentText(digest.mainRead || ''),
    scoreLine: compactPublicAgentText(digest.scoreLine || ''),
    roomSplit: compactPublicAgentText(digest.roomSplit || ''),
    actionBreakdown: publicDigestBars(digest.actionBreakdown, ['try_now', 'bookmark', 'bounce', 'call_bs']),
    readSignals: publicDigestBars(digest.readSignals, ['trust', 'clarity', 'urgency']),
    directionalLabel: compactPublicAgentText(digest.directionalLabel || 'Directional synthetic read, not live analytics.'),
    topBlocker: compactPublicAgentText(digest.topBlocker || ''),
    evidenceQuality,
    fastestVoteMover: compactPublicAgentText(digest.fastestVoteMover || ''),
    firstFix: compactPublicAgentText(digest.firstFix || ''),
    whyItMatters: compactPublicAgentText(digest.whyItMatters || ''),
  });
}

function publicDigestBars(items = [], allowedIds = []) {
  return (Array.isArray(items) ? items : [])
    .filter((item) => allowedIds.includes(item?.id))
    .map((item) => stripUndefined({ id: compactPublicAgentText(item.id || ''), label: compactPublicAgentText(item.label || ''), value: Math.max(0, Math.min(100, Math.round(Number(item.value || 0)))) }))
    .slice(0, allowedIds.length);
}

function publicEvidence(evidence = []) {
  return evidence
    .filter((item) => !/miroshark_job|persona|personas|synthetic reviewer|reviewer signals|simulated users|vote split|panel|primary objection|internal MiroShark|agent run tag|\bow_|follow-up request|Shark Mode MiroShark report path/i.test(`${item?.kind || ''} ${item?.text || ''} ${item?.summary || ''}`))
    .map((item) => stripUndefined({
      kind: compactPublicAgentText(item.kind || 'evidence'),
      text: compactPublicAgentText(item.text || item.summary || item.kind || ''),
      summary: item.summary ? compactPublicAgentText(item.summary) : undefined,
      url: safePublicUrl(item.url || item.href || ''),
      source: item.source ? compactPublicAgentText(item.source) : undefined,
    }))
    .slice(0, 6);
}

function publicExternalSource(source = {}) {
  if (!source || typeof source !== 'object') return null;
  return stripUndefined({
    id: compactPublicAgentText(source.id || ''),
    label: compactPublicAgentText(source.label || source.name || source.attribution || ''),
    attribution: compactPublicAgentText(source.attribution || ''),
    summary: compactPublicAgentText(source.summary || ''),
    status: compactPublicAgentText(source.status || ''),
    confidence: typeof source.confidence === 'number' ? source.confidence : undefined,
    url: safePublicUrl(source.url || ''),
  });
}

function publicSourceReport(report = {}) {
  if (!report || typeof report !== 'object') return undefined;
  return stripUndefined({
    jobId: compactPublicAgentText(report.jobId || report.id || ''),
    stage: compactPublicAgentText(report.stage || report.step || report.status || ''),
    status: compactPublicAgentText(report.status || ''),
    progress: publicJsonSubset(report.progress, 1200),
    trackingUrl: safePublicUrl(report.trackingUrl || report.waitUrl || report.shareUrl || ''),
    waitUrl: safePublicUrl(report.waitUrl || ''),
    shareUrl: safePublicUrl(report.shareUrl || ''),
    syntheticCount: typeof report.syntheticCount === 'number' ? report.syntheticCount : undefined,
    error: report.error ? compactPublicAgentText(report.error) : undefined,
    summary: report.summary ? compactPublicAgentText(report.summary) : undefined,
  });
}

function publicJsonSubset(value, maxChars = 8000) {
  if (value == null) return undefined;
  try {
    const text = JSON.stringify(value);
    if (!text || text.length > maxChars) return undefined;
    const parsed = JSON.parse(text);
    return sanitizePublicJson(parsed);
  } catch {
    return undefined;
  }
}

function sanitizePublicJson(value) {
  if (value == null) return value;
  if (typeof value === 'string') return sanitizePublicAgentText(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map(sanitizePublicJson).slice(0, 80);
  if (typeof value === 'object') {
    const blocked = /personaPanel|disagreementRound|memoryFeedback|runtimeFeedback|collectorEvidence|scoreCalibration|skillEvidence|runMemory|disputePacket|changedMinds|trace|raw|secret|private|apiKey|token/i;
    const out = {};
    for (const [key, nested] of Object.entries(value)) {
      if (blocked.test(key)) continue;
      out[key] = sanitizePublicJson(nested);
    }
    return out;
  }
  return undefined;
}

function safePublicUrl(value = '') {
  const url = String(value || '').trim();
  if (!url) return undefined;
  if (/^(https?:\/\/|\/)/i.test(url) && !/[\n\r]/.test(url)) return url.slice(0, 500);
  return undefined;
}

function compactPublicAgentText(value = '') {
  const clean = sanitizePublicAgentText(value);
  return clean.length > 260 ? `${clean.slice(0, 257).trim()}...` : clean;
}

function sanitizePublicAgentText(value = '') {
  return String(value || '')
    .replace(/\n\nFollow-up request:[\s\S]*$/i, '')
    .replace(/Follow-up request:[\s\S]*$/i, '')
    .replace(/shark MiroShark source report path/ig, 'source report path')
    .trim();
}

function publicTrace(trace = []) {
  return trace
    .filter((item) => !['personas_loaded', 'personas_selected', 'persona_panel', 'hermes_brain'].includes(item.kind))
    .map((item) => ({ kind: item.kind === 'tool' ? 'source' : item.kind, name: item.name, status: item.status, summary: item.summary }))
    .slice(-5);
}

export function publicAgentSession(session) {
  if (!session) return null;
  return {
    id: session.id,
    userId: session.userId,
    status: session.status,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    workingMemory: session.workingMemory,
    messages: (session.messages || []).map((msg) => msg.artifact ? { role: msg.role, content: msg.content, artifact: publicArtifact(msg.artifact) } : msg),
    artifact: publicArtifact(session.artifact || null),
  };
}
