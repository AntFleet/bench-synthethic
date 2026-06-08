const BASE_RPC_URL = 'https://mainnet.base.org';
const DEXSCREENER_URL = 'https://api.dexscreener.com/latest/dex/tokens/';

const SELECTORS = {
  name: '0x06fdde03',
  symbol: '0x95d89b41',
  decimals: '0x313ce567',
  totalSupply: '0x18160ddd',
};

export async function collectBaseTokenMetadata(address, options = {}) {
  const normalized = normalizeAddress(address);
  const fetcher = options.fetcher ?? globalThis.fetch;
  const rpcUrl = options.rpcUrl ?? BASE_RPC_URL;
  const errors = [];
  const result = {
    ok: false,
    chain: 'base',
    address: normalized,
    contract: { isContract: false, codeSize: 0 },
    erc20: null,
    market: null,
    launchpad: detectKnownLaunchpad(normalized),
    sources: [],
    errors,
  };

  if (!normalized) {
    errors.push('invalid evm address');
    return result;
  }

  try {
    const code = await rpc(fetcher, rpcUrl, 'eth_getCode', [normalized, 'latest']);
    const codeHex = typeof code === 'string' ? code : '0x';
    result.contract = { isContract: codeHex !== '0x', codeSize: Math.max(0, (codeHex.length - 2) / 2) };
    result.sources.push('base-rpc:eth_getCode');
  } catch (error) {
    errors.push(`base rpc code failed: ${error.message}`);
  }

  try {
    const [nameRaw, symbolRaw, decimalsRaw, supplyRaw] = await Promise.all([
      ethCall(fetcher, rpcUrl, normalized, SELECTORS.name),
      ethCall(fetcher, rpcUrl, normalized, SELECTORS.symbol),
      ethCall(fetcher, rpcUrl, normalized, SELECTORS.decimals),
      ethCall(fetcher, rpcUrl, normalized, SELECTORS.totalSupply),
    ]);
    const decimals = Number(decodeUintResult(decimalsRaw));
    const totalSupplyRaw = decodeUintResult(supplyRaw);
    result.erc20 = {
      name: decodeStringResult(nameRaw),
      symbol: decodeStringResult(symbolRaw),
      decimals,
      totalSupplyRaw: totalSupplyRaw.toString(),
      totalSupply: decimals >= 0 ? Number(totalSupplyRaw) / 10 ** decimals : null,
    };
    result.sources.push('base-rpc:erc20');
  } catch (error) {
    errors.push(`erc20 metadata failed: ${error.message}`);
  }

  try {
    const market = await fetchDexscreener(fetcher, normalized);
    if (market) {
      result.market = market;
      if ((!result.erc20?.name && !result.erc20?.symbol) && market.baseToken) {
        result.erc20 = {
          ...(result.erc20 || {}),
          name: market.baseToken.name || result.erc20?.name || '',
          symbol: market.baseToken.symbol || result.erc20?.symbol || '',
        };
      }
      result.sources.push('dexscreener');
    }
  } catch (error) {
    errors.push(`dexscreener failed: ${error.message}`);
  }

  result.ok = Boolean(result.contract.isContract || result.erc20 || result.market);
  return result;
}

async function ethCall(fetcher, rpcUrl, to, data) {
  return rpc(fetcher, rpcUrl, 'eth_call', [{ to, data }, 'latest']);
}

async function rpc(fetcher, rpcUrl, method, params) {
  if (!fetcher) throw new Error('fetch unavailable');
  const response = await fetcher(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const payload = await response.json();
  if (payload.error) throw new Error(payload.error.message || 'rpc error');
  return payload.result;
}

async function fetchDexscreener(fetcher, address) {
  if (!fetcher) throw new Error('fetch unavailable');
  const response = await fetcher(`${DEXSCREENER_URL}${address}`);
  const payload = await response.json();
  const pairs = Array.isArray(payload.pairs) ? payload.pairs : [];
  const basePairs = pairs.filter((pair) => pair.chainId === 'base');
  const sorted = basePairs.sort((a, b) => Number(b?.liquidity?.usd || 0) - Number(a?.liquidity?.usd || 0));
  return sorted[0] ? normalizeDexscreenerPair(sorted[0]) : null;
}

export function normalizeDexscreenerPair(pair) {
  return {
    chain: pair.chainId || null,
    dexId: pair.dexId || null,
    pairAddress: pair.pairAddress || null,
    pairUrl: pair.url || null,
    baseToken: pair.baseToken ? {
      name: pair.baseToken.name || null,
      symbol: pair.baseToken.symbol || null,
      address: pair.baseToken.address || null,
    } : null,
    priceUsd: toNumber(pair.priceUsd),
    fdvUsd: toNumber(pair.fdv),
    marketCapUsd: toNumber(pair.marketCap ?? pair.fdv),
    liquidityUsd: toNumber(pair?.liquidity?.usd),
    volume24hUsd: toNumber(pair?.volume?.h24),
    priceChange24hPct: toNumber(pair?.priceChange?.h24),
    websites: Array.isArray(pair.info?.websites) ? pair.info.websites.map(normalizeDexscreenerLink).filter(Boolean).slice(0, 4) : [],
    socials: Array.isArray(pair.info?.socials) ? pair.info.socials.map(normalizeDexscreenerLink).filter(Boolean).slice(0, 8) : [],
  };
}

function normalizeDexscreenerLink(item = {}) {
  const url = typeof item.url === 'string' && /^https?:\/\//i.test(item.url) ? item.url : '';
  if (!url) return null;
  return { type: String(item.type || item.label || '').toLowerCase(), label: item.label || item.type || 'link', url };
}

export function decodeStringResult(hex) {
  if (!hex || hex === '0x') return '';
  const clean = hex.slice(2);
  if (clean.length === 64) return stripNulls(Buffer.from(clean, 'hex').toString('utf8'));
  const offset = Number.parseInt(clean.slice(0, 64), 16);
  if (Number.isFinite(offset) && clean.length >= (offset + 1) * 2 + 64) {
    const lenStart = offset * 2;
    const length = Number.parseInt(clean.slice(lenStart, lenStart + 64), 16);
    const dataStart = lenStart + 64;
    return stripNulls(Buffer.from(clean.slice(dataStart, dataStart + length * 2), 'hex').toString('utf8'));
  }
  return stripNulls(Buffer.from(clean, 'hex').toString('utf8'));
}

export function decodeUintResult(hex) {
  if (!hex || hex === '0x') return 0n;
  return BigInt(hex);
}

function detectKnownLaunchpad(address) {
  return {
    name: null,
    confidence: 0,
    note: 'factory/deployer detection not wired yet; reserved for Clanker, Bankr, Virtuals, Flaunch',
  };
}

function normalizeAddress(address) {
  const value = String(address || '').trim();
  return /^0x[a-fA-F0-9]{40}$/.test(value) ? value.toLowerCase() : null;
}

function stripNulls(value) {
  return value.replace(/\u0000+$/g, '').trim();
}

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
