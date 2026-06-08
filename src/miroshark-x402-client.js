export const MIROSHARK_X402_DEFAULT_ENDPOINT = 'https://miroshark-x402-production.up.railway.app/run';
export const MIROSHARK_X402_DEFAULT_NETWORK = 'eip155:8453';
export const MIROSHARK_X402_USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

export function decodeX402PaymentResponse(header) {
  if (!header) return null;
  const text = String(header).trim();
  for (const candidate of [text, tryBase64(text)]) {
    if (!candidate) continue;
    try {
      const parsed = JSON.parse(candidate);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      // try the next representation
    }
  }
  return null;
}

export function normalizeX402RunResponse({ status = 0, body = null, paymentResponseHeader = '', endpoint = MIROSHARK_X402_DEFAULT_ENDPOINT } = {}) {
  const data = body?.data && typeof body.data === 'object' ? body.data : body || {};
  const settlement = decodeX402PaymentResponse(paymentResponseHeader);
  const ok = status >= 200 && status < 300 && Boolean(data?.run_id || data?.runId || data?.wait_url || data?.waitUrl);
  const runId = data?.run_id || data?.runId || null;
  const waitUrl = data?.wait_url || data?.waitUrl || null;
  const statusUrl = data?.status_url || data?.statusUrl || null;
  const shareUrl = data?.share_url || data?.shareUrl || data?.report_url || data?.reportUrl || null;
  return {
    ok,
    provider: 'x402',
    mode: 'official',
    endpoint,
    statusCode: status,
    runId,
    status: data?.status || (ok ? 'queued' : 'unknown'),
    stages: Array.isArray(data?.stages) ? data.stages : [],
    waitUrl,
    statusUrl,
    shareUrl,
    statusUrlRequiresApiKey: false,
    payer: data?.payer || settlement?.payer || null,
    network: settlement?.network || data?.network || MIROSHARK_X402_DEFAULT_NETWORK,
    settlement,
    raw: { body, paymentResponseHeader: paymentResponseHeader ? '<redacted-header-present>' : null },
  };
}

export function buildX402RunReference(normalized = {}) {
  return {
    provider: 'x402',
    mode: 'official',
    runId: normalized.runId || null,
    status: normalized.status || 'queued',
    waitUrl: normalized.waitUrl || null,
    shareUrl: normalized.shareUrl || null,
    statusUrl: normalized.statusUrl || null,
    statusUrlRequiresApiKey: false,
    endpoint: normalized.endpoint || MIROSHARK_X402_DEFAULT_ENDPOINT,
    payer: normalized.payer || normalized.settlement?.payer || null,
    network: normalized.network || normalized.settlement?.network || MIROSHARK_X402_DEFAULT_NETWORK,
    transaction: normalized.transaction || normalized.settlement?.transaction || null,
    submittedAt: normalized.submittedAt || new Date().toISOString(),
    note: 'Official hosted MiroShark x402 run. Public buyer status is the waitUrl; statusUrl is metadata from the provider response.',
  };
}

export async function checkX402WalletBalance({ privateKey, rpcUrl, usdcAddress = MIROSHARK_X402_USDC_BASE } = {}) {
  const key = privateKey || process.env.MIROSHARK_X402_BUYER_PRIVATE_KEY || process.env.X402_BUYER_PRIVATE_KEY;
  if (!key) return { ok: false, configured: false, error: 'Missing MIROSHARK_X402_BUYER_PRIVATE_KEY or X402_BUYER_PRIVATE_KEY' };
  const [{ createPublicClient, http, erc20Abi, formatUnits }, { base }, { privateKeyToAccount }] = await Promise.all([
    import('viem'),
    import('viem/chains'),
    import('viem/accounts'),
  ]);
  const account = privateKeyToAccount(key);
  const publicClient = createPublicClient({ chain: base, transport: http(rpcUrl || process.env.BASE_RPC_URL || 'https://mainnet.base.org') });
  const balance = await publicClient.readContract({ address: usdcAddress, abi: erc20Abi, functionName: 'balanceOf', args: [account.address] });
  return {
    ok: balance >= 1_000_000n,
    configured: true,
    address: account.address,
    usdc: formatUnits(balance, 6),
    network: MIROSHARK_X402_DEFAULT_NETWORK,
    chain: 'Base mainnet',
    requiredUsdc: '1.0',
  };
}

export async function submitPaidMiroSharkRun({ prompt, endpoint = process.env.MIROSHARK_X402_ENDPOINT || MIROSHARK_X402_DEFAULT_ENDPOINT, privateKey } = {}) {
  const key = privateKey || process.env.MIROSHARK_X402_BUYER_PRIVATE_KEY || process.env.X402_BUYER_PRIVATE_KEY;
  if (!key) throw new Error('Missing MIROSHARK_X402_BUYER_PRIVATE_KEY or X402_BUYER_PRIVATE_KEY');
  if (!prompt || String(prompt).trim().length < 4) throw new Error('MiroShark x402 prompt must be at least 4 chars');

  const [{ wrapFetchWithPayment, x402Client }, { registerExactEvmScheme }, { privateKeyToAccount }] = await Promise.all([
    import('@x402/fetch'),
    import('@x402/evm/exact/client'),
    import('viem/accounts'),
  ]);
  const account = privateKeyToAccount(key);
  const client = new x402Client();
  registerExactEvmScheme(client, { signer: account });
  const fetchWithPayment = wrapFetchWithPayment(fetch, client);
  const res = await fetchWithPayment(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: String(prompt).trim().slice(0, 4000) }),
  });
  const paymentResponseHeader = res.headers.get('payment-response') || res.headers.get('PAYMENT-RESPONSE') || '';
  const bodyText = await res.text();
  let body;
  try { body = bodyText ? JSON.parse(bodyText) : null; } catch { body = { raw: bodyText }; }
  const normalized = normalizeX402RunResponse({ status: res.status, body, paymentResponseHeader, endpoint });
  if (!res.ok || !normalized.ok) {
    const requiredHeader = res.headers.get('payment-required') || res.headers.get('PAYMENT-REQUIRED') || '';
    const required = requiredHeader ? safeDecodePaymentRequired(requiredHeader) : null;
    if (res.status === 402 && required?.accepts?.[0]) {
      const need = required.accepts[0];
      const balance = await safeCheckX402WalletBalance({ privateKey: key, rpcUrl: process.env.BASE_RPC_URL, usdcAddress: need.asset });
      const needUsdc = Number(need.amount || 0) / 1_000_000;
      const network = need.network === 'eip155:8453' ? 'Base mainnet' : (need.network || 'configured network');
      const current = balance?.usdc ?? 'unknown';
      const balanceOk = balance?.ok === true;
      const operatorAction = balanceOk
        ? 'Payment settlement was rejected despite sufficient balance; check x402 facilitator, RPC, wallet signing, or endpoint requirements.'
        : 'Fund the buyer wallet or disable paid MiroShark.';
      throw new Error(`MiroShark payment blocked: hosted x402 now requires ${needUsdc || 1} USDC on ${network}; buyer wallet has ${current} USDC. ${operatorAction}`);
    }
    throw new Error(redactPrivateKey(`MiroShark x402 request failed HTTP ${res.status}: ${JSON.stringify(body).slice(0, 600)}`));
  }
  return normalized;
}

function safeDecodePaymentRequired(header) {
  try {
    const text = String(header || '').trim();
    const json = Buffer.from(text, 'base64').toString('utf8');
    return JSON.parse(json);
  } catch {
    return null;
  }
}

async function safeCheckX402WalletBalance(options = {}) {
  try { return await checkX402WalletBalance(options); } catch { return null; }
}

export function extractShareUrlFromWaitHtml(html = '', baseUrl = '') {
  const match = String(html || '').match(/href=["']([^"']*\/share\/[^"']+)["']/i)
    || String(html || '').match(/https?:\/\/[^\s"']+\/share\/[^\s"']+/i);
  if (!match) return null;
  const href = Array.isArray(match) ? match[1] || match[0] : match[0];
  try {
    return baseUrl ? new URL(href, baseUrl).toString() : href;
  } catch {
    return href;
  }
}


export function parseMiroSharkX402WaitPage(html = '', { url = '', waitUrl = '', baseUrl = '' } = {}) {
  const source = String(html || '');
  const effectiveUrl = url || waitUrl;
  const resolvedBase = baseUrl || originFromUrl(effectiveUrl);
  const status = firstMatch(source, [
    /class=["'][^"']*badge\s+([a-z_-]+)[^"']*["'][^>]*>/i,
    /status\s*<[^>]+class=["'][^"']*badge[^"']*["'][^>]*>\s*([^<]+)/i,
    /status\s*[:·]\s*([a-z_-]+)/i,
  ])?.toLowerCase() || (/>\s*Your simulation is ready\./i.test(source) ? 'completed' : (/Simulation failed|badge failed/i.test(source) ? 'failed' : 'unknown'));
  const error = cleanText(firstMatch(source, [
    /<p[^>]*>\s*Error:\s*([\s\S]*?)<\/p>/i,
    /Error:\s*([^<\n]+)/i,
  ]));
  const runId = firstMatch(source, [
    /run_id\s*<code>\s*([^<]+)\s*<\/code>/i,
    /Run\s+(run_[a-zA-Z0-9_-]+)/i,
    /\b(run_[a-zA-Z0-9_-]+)\b/,
  ]);
  const progressPercent = clampPercent(Number(firstMatch(source, [/width\s*:\s*(\d+(?:\.\d+)?)%/i])));
  const shareHref = firstMatch(source, [
    /<a\b[^>]*class=["'][^"']*report[^"']*["'][^>]*href=["']([^"']+)["']/i,
    /href=["']([^"']*\/share\/[^"']+)["']/i,
    /(https?:\/\/[^\s"'<>]+\/share\/[^\s"'<>]+)/i,
  ]);
  const stages = [...source.matchAll(/<div\b[^>]*class=["'][^"']*stage\s+([^"']+)[^"']*["'][^>]*>\s*<span>\s*([^<]+)\s*<\/span>\s*<span>\s*([^<]*)\s*<\/span>\s*<\/div>/gi)]
    .map((match) => ({ name: decodeHtml(match[2]).trim(), status: normalizeStageStatus(match[1]), duration: decodeHtml(match[3]).trim() }))
    .filter((stage) => stage.name);
  return {
    provider: 'x402',
    mode: 'official',
    source: 'wait_page',
    url: effectiveUrl || null,
    runId: runId || null,
    status,
    progressPercent,
    shareUrl: shareHref ? absolutize(shareHref, resolvedBase || effectiveUrl) : null,
    stages,
    error: error || null,
    completed: status === 'completed',
    failed: status === 'failed',
  };
}

export function parseMiroSharkX402SharePage(html = '', { url = '', baseUrl = '' } = {}) {
  const source = String(html || '');
  const resolvedBase = baseUrl || originFromUrl(url);
  const canonical = firstMatch(source, [
    /<meta\s+property=["']og:url["']\s+content=["']([^"']+)["']/i,
    /<link\s+rel=["']canonical["']\s+href=["']([^"']+)["']/i,
  ]) || url || null;
  const title = cleanText(firstMatch(source, [
    /<h1\b[^>]*class=["'][^"']*hero-title[^"']*["'][^>]*>([\s\S]*?)<\/h1>/i,
    /<meta\s+property=["']og:title["']\s+content=["']([^"']+)["']/i,
    /<title>([\s\S]*?)<\/title>/i,
  ]));
  const description = cleanText(firstMatch(source, [
    /<meta\s+name=["']description["']\s+content=["']([^"']+)["']/i,
    /<meta\s+property=["']og:description["']\s+content=["']([^"']+)["']/i,
  ]));
  const ogImageRaw = firstMatch(source, [/<meta\s+property=["']og:image["']\s+content=["']([^"']+)["']/i, /<meta\s+name=["']twitter:image["']\s+content=["']([^"']+)["']/i]);
  const sections = [...source.matchAll(/<h2\b[^>]*>([\s\S]*?)<\/h2>/gi)].map((m) => cleanText(m[1])).filter(Boolean).slice(0, 12);
  const questions = [...source.matchAll(/<h3\b[^>]*>([\s\S]*?)<\/h3>/gi)].map((m) => cleanText(m[1])).filter(Boolean).slice(0, 12);
  const visibleText = cleanText(source
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' '));
  const metric = (pattern) => firstMatch(visibleText, [pattern]);
  const firstMarket = firstMatch(visibleText, [/Market trajectories\s+(.+?\?)\s+(\d+%\s+YES[^A-Za-z]+)/i]);
  const firstMarketResult = firstMatch(visibleText, [/Market trajectories\s+.+?\?\s+(\d+%\s+YES[^A-Za-z]+)/i]);
  const finalMajority = firstMatch(visibleText, [/final majority:\s*([^\.]+?\))/i]);
  const topPost = firstMatch(visibleText, [/Most-impactful posts\s+Top Twitter posts\s+@\d+\s+\d+ interactions\s+(.+?)(?:\s+@\d+\s+\d+ interactions|$)/i]);
  const stats = {
    rounds: Number(metric(/(\d+)\s+rounds/i)) || null,
    agents: Number(metric(/(\d+)\s+agents/i)) || null,
    actions: Number(metric(/(\d+)\s+agent actions/i)) || null,
    spend: metric(/(\$[0-9.]+)\s+spend/i) || null,
    markets: Number(metric(/(\d+)\s+markets/i)) || null,
    marketQuestion: firstMarket || null,
    marketResult: firstMarketResult || null,
    finalMajority: finalMajority || null,
    topPost: topPost ? topPost.slice(0, 360) : null,
  };
  return {
    provider: 'x402',
    mode: 'official',
    source: 'share_page',
    url: canonical ? absolutize(canonical, resolvedBase || url) : null,
    title,
    description,
    ogImage: ogImageRaw ? absolutize(ogImageRaw, resolvedBase || url) : null,
    sections,
    questions,
    stats,
  };
}


export function statusUrlFromWaitUrl(waitUrl = '') {
  try {
    const url = new URL(waitUrl);
    const match = url.pathname.match(/(?:\/x402)?\/wait\/(run_[a-zA-Z0-9_-]+)/);
    if (!match) return null;
    url.pathname = `/status/${match[1]}`;
    url.search = '';
    return url.toString();
  } catch {
    return null;
  }
}

function parseMiroSharkX402StatusJson(body = {}, fallback = {}) {
  const data = body?.data && typeof body.data === 'object' ? body.data : body || {};
  if (!data || typeof data !== 'object') return null;
  const status = String(data.status || fallback.status || 'unknown').toLowerCase();
  const rawShareUrl = data.share_url || data.shareUrl || fallback.shareUrl || null;
  const waitUrl = data.wait_url || data.waitUrl || fallback.waitUrl || null;
  const shareUrl = rawShareUrl ? absolutize(rawShareUrl, originFromUrl(waitUrl || fallback.waitUrl || fallback.statusUrl || '') || waitUrl || fallback.statusUrl || '') : null;
  const progressPercent = clampPercent(Number(data.progress ?? data.progressPercent ?? fallback.progressPercent ?? 0));
  const stages = data.stages && !Array.isArray(data.stages)
    ? Object.entries(data.stages).map(([name, value]) => ({ name, status: value?.runner_status || value?.status || 'unknown', ...value }))
    : (Array.isArray(data.stages) ? data.stages : fallback.stages || []);
  return {
    provider: 'x402',
    mode: 'official',
    source: 'status_json',
    runId: data.run_id || data.runId || fallback.runId || null,
    status,
    currentStage: data.current_stage || data.currentStage || fallback.currentStage || null,
    progressPercent,
    waitUrl,
    statusUrl: data.status_url || data.statusUrl || fallback.statusUrl || null,
    shareUrl,
    stages,
    error: data.error || fallback.error || null,
    completed: status === 'completed',
    failed: status === 'failed' || Boolean(data.error && /failed|zero rounds|cannot generate/i.test(data.error)),
  };
}

async function fetchJsonMaybe(url, { fetcher = fetch } = {}) {
  if (!url) return null;
  const res = await fetcher(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  const text = await res.text();
  try { return text ? JSON.parse(text) : null; } catch { return null; }
}

export async function pollMiroSharkX402Status(reference = {}, { fetcher = fetch, importReport = true } = {}) {
  const waitUrl = reference.waitUrl || reference.wait_url || null;
  const derivedStatusUrl = statusUrlFromWaitUrl(waitUrl);
  const statusUrl = derivedStatusUrl || reference.statusUrl || reference.status_url || null;
  if (!waitUrl) {
    return {
      status: 'unknown',
      runId: reference.runId || reference.run_id || null,
      waitUrl: null,
      statusUrl,
      shareUrl: reference.shareUrl || reference.share_url || null,
      source: 'missing_wait_url',
      report: null,
      error: 'MiroShark x402 response did not include a wait_url.',
    };
  }

  let statusJson = null;
  if (derivedStatusUrl) {
    try {
      statusJson = parseMiroSharkX402StatusJson(await fetchJsonMaybe(derivedStatusUrl, { fetcher }), { waitUrl, statusUrl: derivedStatusUrl, runId: reference.runId || reference.run_id || null });
    } catch {
      statusJson = null;
    }
  }
  if (statusJson && (statusJson.failed || statusJson.completed || statusJson.status !== 'unknown')) {
    const shareUrl = statusJson.shareUrl || reference.shareUrl || reference.share_url || null;
    const report = shareUrl && importReport ? parseMiroSharkX402SharePage(await fetchText(shareUrl, { fetcher }), { shareUrl }) : null;
    return {
      ...statusJson,
      waitUrl: statusJson.waitUrl || waitUrl,
      statusUrl: statusJson.statusUrl || derivedStatusUrl || statusUrl || null,
      shareUrl,
      report,
      source: report ? 'status_json+share_page' : 'status_json',
    };
  }

  const waitHtml = await fetchText(waitUrl, { fetcher });
  const status = parseMiroSharkX402WaitPage(waitHtml, { waitUrl, runId: reference.runId || reference.run_id || null, statusUrl });
  const shareUrl = status.shareUrl || reference.shareUrl || reference.share_url || null;
  const report = shareUrl && importReport ? parseMiroSharkX402SharePage(await fetchText(shareUrl, { fetcher }), { shareUrl }) : null;
  return {
    ...status,
    statusUrl: status.statusUrl || statusUrl || null,
    shareUrl,
    report,
    source: report ? 'wait_page+share_page' : 'wait_page',
  };
}

function firstMatch(text, patterns) {
  for (const pattern of patterns) {
    const match = String(text || '').match(pattern);
    if (match) return match[1] || match[0] || '';
  }
  return '';
}

function absolutize(value, base) {
  if (!value) return null;
  try { return new URL(value, base || undefined).toString(); } catch { return String(value); }
}

function originFromUrl(value = '') {
  try { return new URL(value).origin; } catch { return ''; }
}

function normalizeStageStatus(value = '') {
  const raw = String(value || '').toLowerCase();
  if (raw.includes('done') || raw.includes('completed') || raw === 'true') return 'done';
  if (raw.includes('active') || raw.includes('running')) return 'active';
  if (raw.includes('fail') || raw.includes('error')) return 'failed';
  return raw.includes('pending') ? 'pending' : (raw || 'unknown');
}

function clampPercent(value) {
  if (!Number.isFinite(value)) return null;
  return Math.max(0, Math.min(100, value));
}

function cleanText(value = '') {
  return decodeHtml(String(value || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
}

function decodeHtml(value = '') {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

async function fetchText(url, { fetcher = fetch } = {}) {
  const res = await fetcher(url, { headers: { accept: 'text/html,application/xhtml+xml,text/plain,*/*' } });
  if (!res.ok) throw new Error(`MiroShark x402 wait/share fetch failed HTTP ${res.status}`);
  return res.text();
}

export function redactPrivateKey(value = '') {
  return String(value || '').replace(/0x[a-fA-F0-9]{64}/g, (key) => `${key.slice(0, 6)}…${key.slice(-4)}`);
}

function tryBase64(value = '') {
  try {
    return Buffer.from(value, 'base64').toString('utf8');
  } catch {
    return '';
  }
}
