export function isXUrl(rawUrl) {
  try {
    const url = new URL(String(rawUrl));
    return /(^|\.)x\.com$|(^|\.)twitter\.com$/i.test(url.hostname) && /\/status\/\d+/.test(url.pathname);
  } catch {
    return false;
  }
}

export async function collectXThreadSignals(rawUrl, options = {}) {
  const parsed = parseXUrl(rawUrl);
  if (!parsed) {
    return { ok: false, source: 'x-thread', url: String(rawUrl), error: 'not an X status URL', objections: [], marketSignals: [] };
  }
  const runner = options.runner;
  if (!runner) {
    return { ok: false, source: 'x-thread', ...parsed, error: 'xurl runner unavailable', objections: [], marketSignals: [] };
  }
  try {
    const stdout = await runner(parsed.url);
    const runnerError = detectRunnerError(stdout);
    if (runnerError) throw new Error(runnerError);
    const posts = normalizeRunnerOutput(stdout);
    if (!posts.length) throw new Error('xurl returned no readable thread posts');
    const threadText = posts.map((post) => post.text).filter(Boolean).join('\n');
    return {
      ok: true,
      source: 'x-thread',
      ...parsed,
      posts,
      threadText,
      objections: extractObjections(threadText),
      marketSignals: extractMarketSignals(threadText),
      socialSignals: extractSocialSignals(threadText),
    };
  } catch (error) {
    return { ok: false, source: 'x-thread', ...parsed, error: error.message, objections: [], marketSignals: [] };
  }
}


function detectRunnerError(stdout) {
  const raw = String(stdout || '').trim();
  if (!raw) return 'xurl returned empty output';
  try {
    const parsed = JSON.parse(raw);
    if (parsed?.status >= 400) return parsed.detail || parsed.title || `X API error ${parsed.status}`;
    if (Array.isArray(parsed?.errors) && parsed.errors.length) return parsed.errors.map((item) => item?.detail || item?.message || JSON.stringify(item)).join('; ');
  } catch {}
  return '';
}

function parseXUrl(rawUrl) {
  try {
    const url = new URL(String(rawUrl));
    if (!isXUrl(url.toString())) return null;
    const parts = url.pathname.split('/').filter(Boolean);
    const statusIndex = parts.indexOf('status');
    return {
      url: url.toString(),
      handle: parts[0]?.replace(/^@/, '') || '',
      statusId: parts[statusIndex + 1] || '',
    };
  } catch {
    return null;
  }
}

function normalizeRunnerOutput(stdout) {
  const raw = String(stdout || '').trim();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    const posts = parsed.posts || parsed.tweets || parsed.data || (Array.isArray(parsed) ? parsed : []);
    return posts.map((post) => ({
      text: String(post.text || post.full_text || post.content || '').trim(),
      author: post.author || post.username || post.handle || '',
      createdAt: post.created_at || post.createdAt || '',
    })).filter((post) => post.text);
  } catch {
    return raw.split('\n').map((line) => ({ text: line.trim() })).filter((post) => post.text);
  }
}

function extractObjections(text) {
  return splitLines(text).filter((line) => /proof|scam|farm|exit|rug|why|without|fake|liquidity|team|ca|audit|holders?/i.test(line)).slice(0, 10);
}

function extractMarketSignals(text) {
  return splitLines(text).filter((line) => /holder|liquidity|meme|narrative|market cap|mc|pump|sell|buy|volume|launch|base|token|utility|catalyst/i.test(line)).slice(0, 10);
}

function extractSocialSignals(text) {
  return splitLines(text).filter((line) => /share|thread|kol|reply|community|meme|viral|attention|timeline/i.test(line)).slice(0, 10);
}

function splitLines(text) {
  return String(text).split(/\n|(?<=[.!?])\s+/).map((x) => x.trim()).filter(Boolean);
}
