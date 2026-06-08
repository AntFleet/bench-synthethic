import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  MIROSHARK_X402_DEFAULT_ENDPOINT,
  buildX402RunReference,
  decodeX402PaymentResponse,
  normalizeX402RunResponse,
  parseMiroSharkX402SharePage,
  parseMiroSharkX402WaitPage,
  pollMiroSharkX402Status,
  redactPrivateKey,
} from '../src/miroshark-x402-client.js';

test('normalizeX402RunResponse unwraps documented {success,data} envelope and payment header', () => {
  const settlement = { success: true, transaction: '0xabc', network: 'eip155:84532', payer: '0xPayer' };
  const header = Buffer.from(JSON.stringify(settlement), 'utf8').toString('base64');
  const body = {
    success: true,
    data: {
      run_id: 'run_86ead0ea7fa7',
      status: 'queued',
      wait_url: 'https://miroshark-x402-production.up.railway.app/wait/run_86ead0ea7fa7',
      status_url: 'https://miroshark-x402-production.up.railway.app/api/run/status/run_86ead0ea7fa7',
      payer: '0xPayer',
    },
  };

  const normalized = normalizeX402RunResponse({ status: 202, body, paymentResponseHeader: header, endpoint: MIROSHARK_X402_DEFAULT_ENDPOINT });

  assert.equal(normalized.ok, true);
  assert.equal(normalized.provider, 'x402');
  assert.equal(normalized.runId, 'run_86ead0ea7fa7');
  assert.equal(normalized.waitUrl, body.data.wait_url);
  assert.equal(normalized.statusUrlRequiresApiKey, false);
  assert.equal(normalized.settlement.transaction, '0xabc');
  assert.equal(normalized.network, 'eip155:84532');
});

test('buildX402RunReference is safe for UI/job store and excludes secrets', () => {
  const ref = buildX402RunReference({
    runId: 'run_1',
    waitUrl: 'https://example.test/wait/run_1',
    statusUrl: 'https://example.test/status/run_1',
    payer: '0xabc',
    settlement: { transaction: '0xtx', network: 'eip155:84532', payer: '0xabc' },
    endpoint: 'https://example.test/x402/run',
    privateKey: '0xdeadbeef',
  });

  const serialized = JSON.stringify(ref);
  assert.equal(ref.provider, 'x402');
  assert.equal(ref.mode, 'official');
  assert.equal(ref.statusUrlRequiresApiKey, false);
  assert.equal(ref.transaction, '0xtx');
  assert.doesNotMatch(serialized, /deadbeef/i);
  assert.doesNotMatch(serialized, /privateKey/i);
});

test('decodeX402PaymentResponse tolerates raw JSON and base64 JSON headers', () => {
  const payload = { success: true, transaction: '0x123', network: 'eip155:84532' };
  assert.deepEqual(decodeX402PaymentResponse(JSON.stringify(payload)), payload);
  assert.deepEqual(decodeX402PaymentResponse(Buffer.from(JSON.stringify(payload)).toString('base64')), payload);
  assert.equal(decodeX402PaymentResponse('not json'), null);
});

test('redactPrivateKey masks EVM private keys in error/debug strings', () => {
  const text = 'failed with key 0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa and more';
  assert.equal(redactPrivateKey(text).includes('aaaaaaaaaaaaaaaa'), false);
  assert.match(redactPrivateKey(text), /0xaaaa…aaaa/);
});


test('x402 SDK dependencies from INTEGRATION.md are declared for deployable paid path', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  for (const dep of ['@x402/fetch', '@x402/evm', 'viem']) {
    assert.ok(pkg.dependencies?.[dep], dep + ' must be declared in package.json');
  }
});


test('parseMiroSharkX402WaitPage extracts completed wait-page share links and stages', () => {
  const html = `<!doctype html><html><head><title>MiroShark — Run run_demo123</title></head><body>
    <h1>Your simulation is ready.</h1>
    <div class="meta">run_id <code>run_demo123</code> · status <span class="badge completed">completed</span></div>
    <div class="bar"><div style="width:100%"></div></div>
    <div class="stages"><div class="stage done"><span>ingest</span><span>7.5s</span></div><div class="stage done"><span>report</span><span>47.1s</span></div></div>
    <a class="report" href="/share/sim_55bec46400c4">View report →</a>
  </body></html>`;

  const parsed = parseMiroSharkX402WaitPage(html, { url: 'https://miroshark-x402-production.up.railway.app/wait/run_demo123' });

  assert.equal(parsed.status, 'completed');
  assert.equal(parsed.runId, 'run_demo123');
  assert.equal(parsed.progressPercent, 100);
  assert.equal(parsed.shareUrl, 'https://miroshark-x402-production.up.railway.app/share/sim_55bec46400c4');
  assert.deepEqual(parsed.stages.map((stage) => [stage.name, stage.status]), [['ingest', 'done'], ['report', 'done']]);
});

test('parseMiroSharkX402SharePage extracts report metadata without raw HTML', () => {
  const html = `<!doctype html><html><head>
    <title>MiroShark — Demo report</title>
    <meta name="description" content="A 72-hour simulation summary.">
    <meta property="og:image" content="https://example.test/card.png">
    <meta property="og:url" content="https://example.test/share/sim_demo">
  </head><body><h1 class="hero-title">Demo report headline</h1><h2 class="mp-section-h">Market trajectories</h2><h3 class="mp-market-q">Will paid reports convert?</h3></body></html>`;

  const parsed = parseMiroSharkX402SharePage(html, { url: 'https://example.test/share/sim_demo' });

  assert.equal(parsed.url, 'https://example.test/share/sim_demo');
  assert.equal(parsed.title, 'Demo report headline');
  assert.equal(parsed.description, 'A 72-hour simulation summary.');
  assert.equal(parsed.ogImage, 'https://example.test/card.png');
  assert.deepEqual(parsed.sections, ['Market trajectories']);
  assert.deepEqual(parsed.questions, ['Will paid reports convert?']);
  assert.equal('html' in parsed, false);
});

test('pollMiroSharkX402Status uses the public wait_url as the buyer-facing source of truth', async () => {
  const calls = [];
  const fetcher = async (url, options = {}) => {
    calls.push({ url, headers: options.headers || {} });
    assert.equal(String(url).includes('/api/run/status/'), false);
    if (String(url).includes('/status/')) {
      return new Response(JSON.stringify({ success: true, data: { run_id: 'run_wait', status: 'completed', progress: 100, share_url: 'https://example.test/share/sim_wait' } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (String(url).includes('/wait/')) {
      return new Response('<html><body><p>Status: completed</p><a class="report" href="/share/sim_wait">View report</a></body></html>', { status: 200, headers: { 'content-type': 'text/html' } });
    }
    if (String(url).includes('/share/sim_wait')) {
      return new Response('<html><head><meta name="description" content="done"><meta property="og:url" content="https://example.test/share/sim_wait"></head><body><h1 class="hero-title">Imported report</h1></body></html>', { status: 200, headers: { 'content-type': 'text/html' } });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  const status = await pollMiroSharkX402Status({ runId: 'run_wait', statusUrl: 'https://example.test/api/run/status/run_wait', waitUrl: 'https://example.test/wait/run_wait' }, { fetcher });

  assert.equal(status.status, 'completed');
  assert.equal(status.shareUrl, 'https://example.test/share/sim_wait');
  assert.equal(status.report.title, 'Imported report');
  assert.equal(status.report.description, 'done');
  assert.equal(calls[0].url, 'https://example.test/status/run_wait');
  assert.equal(calls.some((call) => String(call.url).includes('/api/run/status/')), false);
  assert.equal(calls.at(-1).url, 'https://example.test/share/sim_wait');
});


test('pollMiroSharkX402Status keeps working from public wait page without any API key', async () => {
  const calls = [];
  const fetcher = async (url, options = {}) => {
    calls.push({ url, headers: options.headers || {} });
    if (String(url).includes('/status/')) {
      return new Response(JSON.stringify({ success: true, data: { run_id: 'run_wait', status: 'completed', progress: 100, share_url: 'https://example.test/share/sim_wait' } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (String(url).includes('/wait/')) {
      return new Response('<html><body><div class="meta">run_id <code>run_wait</code> · status <span class="badge completed">completed</span></div><div class="bar"><div style="width:100%"></div></div><a class="report" href="/share/sim_wait">View report</a></body></html>', { status: 200, headers: { 'content-type': 'text/html' } });
    }
    if (String(url).includes('/share/sim_wait')) {
      return new Response('<html><head><meta name="description" content="wait done"></head><body><h1 class="hero-title">Wait imported</h1></body></html>', { status: 200, headers: { 'content-type': 'text/html' } });
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  const status = await pollMiroSharkX402Status({ runId: 'run_wait', statusUrl: 'https://example.test/api/run/status/run_wait', waitUrl: 'https://example.test/wait/run_wait' }, { fetcher });

  assert.equal(status.status, 'completed');
  assert.equal(status.shareUrl, 'https://example.test/share/sim_wait');
  assert.equal(status.report.title, 'Wait imported');
  assert.equal(calls[0].url, 'https://example.test/status/run_wait');
  assert.equal(calls.some((call) => String(call.url).includes('/api/run/status/')), false);
});


test('parseMiroSharkX402WaitPage extracts failed wait-page error and progress', () => {
  const html = `<!doctype html><html><body>
    <h1>Simulation failed.</h1>
    <div class="meta">run_id <code>run_2cc15046cfc8</code> · status <span class="badge failed">failed</span></div>
    <div class="bar"><div style="width:55%"></div></div>
    <p style="color:#E04545">Error: simulate stage produced zero rounds — cannot generate a meaningful report</p>
  </body></html>`;
  const parsed = parseMiroSharkX402WaitPage(html, { waitUrl: 'https://miroshark-x402-production.up.railway.app/wait/run_2cc15046cfc8' });
  assert.equal(parsed.status, 'failed');
  assert.equal(parsed.failed, true);
  assert.equal(parsed.progressPercent, 55);
  assert.match(parsed.error, /zero rounds/);
});

test('pollMiroSharkX402Status follows public x402 status JSON from wait URL and surfaces terminal failure', async () => {
  const calls = [];
  const fetcher = async (url) => {
    calls.push(String(url));
    if (String(url).includes('/status/run_2cc15046cfc8')) {
      return new Response(JSON.stringify({ success: true, data: {
        run_id: 'run_2cc15046cfc8', status: 'failed', progress: 55, current_stage: 'simulate',
        error: 'simulate stage produced zero rounds — cannot generate a meaningful report', share_url: null,
        stages: { simulate: { status: 'partial', runner_status: 'failed', rounds: 0, actions: 0 }, report: { status: 'pending' } }
      }}), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (String(url).includes('/wait/run_2cc15046cfc8')) {
      return new Response('<html><body><span class="badge failed">failed</span><div class="bar"><div style="width:55%"></div></div><p>Error: simulate stage produced zero rounds — cannot generate a meaningful report</p></body></html>', { status: 200, headers: { 'content-type': 'text/html' } });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  const status = await pollMiroSharkX402Status({ runId: 'run_2cc15046cfc8', waitUrl: 'https://miroshark-x402-production.up.railway.app/wait/run_2cc15046cfc8' }, { fetcher });
  assert.equal(status.status, 'failed');
  assert.equal(status.failed, true);
  assert.equal(status.progressPercent, 55);
  assert.match(status.error, /zero rounds/);
  assert.equal(status.currentStage, 'simulate');
  assert.equal(calls[0], 'https://miroshark-x402-production.up.railway.app/status/run_2cc15046cfc8');
});
