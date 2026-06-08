import test from 'node:test';
import assert from 'node:assert/strict';

import { collectBaseTokenMetadata, decodeStringResult, normalizeDexscreenerPair } from '../src/base-token-metadata.js';

function encodeString(value) {
  const hex = Buffer.from(value, 'utf8').toString('hex');
  const len = (hex.length / 2).toString(16).padStart(64, '0');
  const padded = hex.padEnd(Math.ceil(hex.length / 64) * 64, '0');
  return `0x${'20'.padStart(64, '0')}${len}${padded}`;
}

function encodeUint(value) {
  return `0x${BigInt(value).toString(16).padStart(64, '0')}`;
}

test('decodes dynamic ERC20 string return values', () => {
  assert.equal(decodeStringResult(encodeString('Synthetic Users')), 'Synthetic Users');
  assert.equal(decodeStringResult(encodeString('SYN')), 'SYN');
});

test('normalizes Dexscreener pair into market metadata', () => {
  const pair = normalizeDexscreenerPair({
    chainId: 'base',
    dexId: 'uniswap',
    pairAddress: '0xpair',
    priceUsd: '0.0012',
    fdv: 1200000,
    marketCap: 950000,
    liquidity: { usd: 82000 },
    volume: { h24: 123000 },
    priceChange: { h24: -8.3 },
    url: 'https://dexscreener.com/base/0xpair',
  });
  assert.equal(pair.chain, 'base');
  assert.equal(pair.priceUsd, 0.0012);
  assert.equal(pair.liquidityUsd, 82000);
  assert.equal(pair.marketCapUsd, 950000);
  assert.equal(pair.pairUrl, 'https://dexscreener.com/base/0xpair');
});

test('collects ERC20 metadata and market data through injectable fetch', async () => {
  const calls = [];
  const fetcher = async (url, options = {}) => {
    calls.push({ url: String(url), body: options.body ? JSON.parse(options.body) : null });
    if (String(url).includes('dexscreener')) {
      return jsonResponse({ pairs: [{ chainId: 'base', dexId: 'uniswap', priceUsd: '0.02', fdv: 2000000, liquidity: { usd: 100000 }, volume: { h24: 40000 }, url: 'https://dexscreener.com/base/0xpair' }] });
    }
    const method = JSON.parse(options.body).method;
    if (method === 'eth_getCode') return jsonResponse({ jsonrpc: '2.0', id: 1, result: '0x60806040' });
    const data = JSON.parse(options.body).params[0].data;
    if (data === '0x06fdde03') return jsonResponse({ jsonrpc: '2.0', id: 1, result: encodeString('Synthetic') });
    if (data === '0x95d89b41') return jsonResponse({ jsonrpc: '2.0', id: 1, result: encodeString('SYN') });
    if (data === '0x313ce567') return jsonResponse({ jsonrpc: '2.0', id: 1, result: encodeUint(18) });
    if (data === '0x18160ddd') return jsonResponse({ jsonrpc: '2.0', id: 1, result: encodeUint('1000000000000000000000000') });
    throw new Error('unexpected call');
  };

  const meta = await collectBaseTokenMetadata('0xfe848a4e279e762ad409a84d4e164324b8d26ba3', { fetcher });
  assert.equal(meta.ok, true);
  assert.equal(meta.contract.isContract, true);
  assert.equal(meta.erc20.name, 'Synthetic');
  assert.equal(meta.erc20.symbol, 'SYN');
  assert.equal(meta.erc20.decimals, 18);
  assert.equal(meta.market.priceUsd, 0.02);
  assert.equal(meta.market.liquidityUsd, 100000);
  assert.ok(calls.some((call) => String(call.url).includes('mainnet.base.org')));
});

test('fails soft when RPC or DEX metadata is unavailable', async () => {
  const fetcher = async () => { throw new Error('network down'); };
  const meta = await collectBaseTokenMetadata('0xfe848a4e279e762ad409a84d4e164324b8d26ba3', { fetcher });
  assert.equal(meta.ok, false);
  assert.equal(meta.address, '0xfe848a4e279e762ad409a84d4e164324b8d26ba3');
  assert.ok(meta.errors.length >= 1);
});

function jsonResponse(payload) {
  return { ok: true, status: 200, async json() { return payload; } };
}
