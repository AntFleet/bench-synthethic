
import { routeIntent } from './intent-router.js';
import { buildPersonaSet } from './personas.js';
import { collectSyntheticSignals } from './synthetic-data.js';
import { collectBaseTokenMetadata } from './base-token-metadata.js';
import { buildDisagreementMap, buildMarketQuestions, buildMemo, buildPublicThread, buildRounds } from './report-builder.js';
import { buildResultExplainer } from './result-explainer.js';

export async function runSyntheticSimulation(input, options = {}) {
  const routedIntent = routeIntent(input);
  const intent = options.openWorldEvidenceSource
    ? forceOpenWorldIntent(routedIntent, options.openWorldEvidenceSource)
    : routedIntent;
  const tokenMetadata = await maybeCollectTokenMetadata(intent, options);
  const signals = await collectSyntheticSignals({ intent: intent.intent, input: intent.input, inputKind: intent.inputKind, tokenMetadata, options });
  const effectiveIntent = applyEvidenceDerivedIntent(intent, signals);
  const personas = buildPersonaSet(effectiveIntent);
  const rounds = buildRounds(effectiveIntent, personas, signals);
  const publicThread = buildPublicThread(effectiveIntent, personas, signals);
  const memo = buildMemo(effectiveIntent, personas, signals, rounds, tokenMetadata);
  const disagreementMap = buildDisagreementMap(rounds);
  const marketQuestions = buildMarketQuestions(effectiveIntent, signals, tokenMetadata);
  const baseResult = {
    ok: true,
    version: '1.2',
    generatedAt: new Date().toISOString(),
    input: intent.input,
    intent: effectiveIntent,
    tokenMetadata,
    personas,
    signals,
    rounds,
    disagreementMap,
    marketQuestions,
    publicThread,
    memo,
  };
  return {
    ...baseResult,
    explainer: buildResultExplainer(baseResult),
  };
}


function forceOpenWorldIntent(intent, evidence = {}) {
  const evidenceDomain = evidence.domain || intent.openWorldDomain || 'synthetic-system';
  return {
    ...intent,
    intent: 'open_world_question',
    inputKind: 'question',
    primaryQuestion: intent.primaryQuestion || 'What is the best answer after understanding the domain, collecting relevant signals, and testing uncertainty?',
    audience: domainAudience(evidenceDomain),
    openWorldDomain: evidenceDomain,
    openWorldSubdomain: evidence.subdomain || intent.openWorldSubdomain || 'miroshark-report',
    answerType: evidence.answerType || intent.answerType || 'analysis',
  };
}


function domainAudience(domain) {
  if (domain === 'sports') return ['sports analyst', 'tournament forecaster', 'squad-depth scout', 'skeptical sports fan', 'casual fan'];
  if (domain === 'crypto-strategy') return ['crypto operator', 'Base trader', 'liquidity watcher', 'skeptical holder', 'builder'];
  return ['domain analyst', 'operator', 'skeptic', 'power user', 'casual user'];
}

function applyEvidenceDerivedIntent(intent, signals = {}) {
  if (intent.intent !== 'open_world_question') return intent;
  const research = (signals.evidenceSources || []).find((source) => source.source === 'open-world-research');
  if (!research?.domain || research.domain === intent.openWorldDomain) return intent;
  return {
    ...intent,
    openWorldDomain: research.domain,
    openWorldSubdomain: research.subdomain || intent.openWorldSubdomain,
    answerType: research.answerType || intent.answerType,
  };
}

async function maybeCollectTokenMetadata(intent, options) {
  if (intent.inputKind !== 'contract_address' || intent.intent !== 'synthetic_launch') return null;
  if (options.skipTokenMetadata) return null;
  return collectBaseTokenMetadata(intent.contractAddress, options.tokenMetadataOptions || {});
}
