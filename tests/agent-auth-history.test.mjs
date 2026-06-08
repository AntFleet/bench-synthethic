import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createAgentSessionStore } from '../src/agent/session-store.js';

test('agent sessions are owner-scoped and list only substantive user requests', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'agent-history-'));
  try {
    const store = createAgentSessionStore({ dir });
    const a = await store.create({ userId: 'wallet:0xaaa', input: '' });
    const b = await store.create({ userId: 'google:user@example.com', input: '' });
    await store.appendMessage(a.id, { role: 'user', content: 'hello' });
    await store.appendMessage(a.id, { role: 'assistant', content: 'hi' });
    await store.appendMessage(a.id, { role: 'user', content: 'simulate launch opinion for Gitlawb on Base' });
    await store.appendMessage(b.id, { role: 'user', content: 'simulate different product for another user' });

    const historyA = await store.listRequests({ userId: 'wallet:0xaaa' });
    const historyB = await store.listRequests({ userId: 'google:user@example.com' });

    assert.deepEqual(historyA.map((item) => item.title), ['simulate launch opinion for Gitlawb on Base']);
    assert.equal(historyA[0].sessionId, a.id);
    assert.deepEqual(historyB.map((item) => item.title), ['simulate different product for another user']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('agent store denies cross-owner session reads when owner is supplied', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'agent-owner-'));
  try {
    const store = createAgentSessionStore({ dir });
    const session = await store.create({ userId: 'wallet:0xaaa', input: 'simulate owned request' });
    assert.equal((await store.get(session.id, { userId: 'wallet:0xaaa' })).id, session.id);
    assert.equal(await store.get(session.id, { userId: 'wallet:0xbbb' }), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});


test('agent server exposes Privy auth/config endpoints and routes ownership through verified user id', async () => {
  const server = await readFile(new URL('../scripts/server.mjs', import.meta.url), 'utf8');
  assert.match(server, /\/api\/auth\/config/);
  assert.match(server, /\/api\/auth\/me/);
  assert.match(server, /resolveRequestUser/);
  assert.match(server, /verifyPrivyAccessToken/);
  assert.match(server, /claims\?\.user_id/);
  assert.match(server, /debugHeaders/);
  assert.match(server, /\/api\/agent\/history/);
  assert.match(server, /handleCreateAgentSession\(\{ store: agentSessionStore, body: \{ \.\.\.parsed, userId/);
  assert.match(server, /handleAgentMessage\([\s\S]*body: \{ \.\.\.parsed, userId/);
  assert.doesNotMatch(server, /\/api\/auth\/google\/start/);
  assert.doesNotMatch(server, /\/api\/auth\/wallet\/nonce/);
  assert.doesNotMatch(server, /\/api\/auth\/wallet\/verify/);
});

test('agent UI uses provider-neutral account settings history shell without old Google or wallet buttons', async () => {
  const html = await readFile(new URL('../public/agent.html', import.meta.url), 'utf8');
  assert.match(html, /data-privy-auth-root/);
  assert.match(html, /data-entry-guest/);
  assert.match(html, /data-entry-privy/);
  assert.doesNotMatch(html, /data-privy-guest>Continue as guest/);
  assert.doesNotMatch(html, /data-privy-login>Sign in/);
  assert.match(html, /data-profile-card/);
  assert.match(html, /data-settings-panel/);
  assert.match(html, /data-theme-toggle/);
  assert.match(html, /data-top-settings/);
  assert.match(html, /data-theme-pick="dark"/);
  assert.match(html, /data-theme-pick="light"/);
  assert.doesNotMatch(html, /data-theme-pick="based"/);
  assert.match(html, /data-synthetic-count/);
  assert.match(html, /data-auth-wallet/);
  assert.match(html, /data-privy-disconnect/);
  assert.match(html, /data-request-history/);
  assert.match(html, /History/);
  assert.match(html, /Account[\s\S]*Appearance/);
  assert.doesNotMatch(html, /data-auth-google/);
  assert.doesNotMatch(html, />Google<\/button>/);
  assert.doesNotMatch(html, />Wallet<\/button>/);
  assert.doesNotMatch(html, />Run<\/a>/);
});

test('agent history exposes shareable request summaries instead of full chat transcripts', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'agent-share-history-'));
  try {
    const store = createAgentSessionStore({ dir });
    const session = await store.create({ userId: 'privy:guest_1', input: '' });
    await store.appendMessage(session.id, { role: 'user', content: 'simulate market reaction for a Base AI terminal launch' });
    await store.appendMessage(session.id, { role: 'assistant', content: 'Verdict: useful, but needs proof. Long private internal trace should not appear.' });
    await store.appendMessage(session.id, { role: 'user', content: 'thanks' });
    const history = await store.listRequests({ userId: 'privy:guest_1' });
    assert.equal(history.length, 1);
    assert.equal(history[0].question, 'simulate market reaction for a Base AI terminal launch');
    assert.match(history[0].finalAnswer, /Verdict: useful/);
    assert.equal(history[0].messages, undefined);
    assert.equal(history[0].shareText.includes('simulate market reaction'), true);
    assert.equal(history[0].shareText.includes('Verdict: useful'), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});


test('top nav hides the current page tab on public surfaces', async () => {
  const pages = [
    ['../public/index.html', 'Home'],
    ['../public/agent.html', 'Terminal'],
    ['../public/token.html', 'Token'],
    ['../public/docs.html', 'Docs'],
  ];
  for (const [file, current] of pages) {
    const html = await readFile(new URL(file, import.meta.url), 'utf8');
    const nav = html.match(/<div class="nav-links">[\s\S]*?<\/div>/)?.[0] || '';
    assert.ok(nav, `${file} nav exists`);
    assert.doesNotMatch(nav, new RegExp(`>${current}<`), `${file} hides current tab`);
  }
});
