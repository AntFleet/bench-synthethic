import { mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

const SECRET_KEY_PATTERN = /(secret|private|token|password|api[_-]?key|bearer|mnemonic|seed)/i;

export function createAgentSessionStore({ dir }) {
  if (!dir) throw new Error('Agent session store requires dir');

  async function ensureDir() {
    await mkdir(dir, { recursive: true });
  }

  function fileFor(id) {
    const clean = String(id || '').replace(/[^a-zA-Z0-9_-]/g, '');
    if (!clean) throw new Error('Invalid agent session id');
    return path.join(dir, `${clean}.json`);
  }

  async function save(session) {
    await ensureDir();
    const safe = sanitizeForStorage({ ...session, updatedAt: new Date().toISOString() });
    await writeFile(fileFor(safe.id), `${JSON.stringify(safe, null, 2)}\n`, 'utf8');
    return safe;
  }

  return {
    async create({ input = '', userId = 'anon' } = {}) {
      await ensureDir();
      const now = new Date().toISOString();
      const cleanInput = String(input || '').trim();
      const session = {
        id: `agent_${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`,
        status: 'idle',
        userId: normalizeUserId(userId),
        createdAt: now,
        updatedAt: now,
        workingMemory: {
          lastUserGoal: cleanInput,
          summary: cleanInput ? `User asked: ${cleanInput.slice(0, 220)}` : '',
          evidenceCount: 0,
        },
        messages: cleanInput ? [{ role: 'user', content: cleanInput, createdAt: now }] : [],
        trace: [],
        artifact: null,
      };
      return save(session);
    },

    async get(id, { userId } = {}) {
      try {
        const session = JSON.parse(await readFile(fileFor(id), 'utf8'));
        if (userId) {
          const owner = normalizeUserId(userId);
          if (!session.userId && owner !== 'anon') return null;
          if (session.userId && session.userId !== owner) return null;
        }
        return session;
      } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
      }
    },

    save,

    async appendMessage(id, message) {
      const session = await this.get(id);
      if (!session) throw new Error('Agent session not found');
      const next = {
        ...session,
        messages: [...(session.messages || []), sanitizeForStorage({ ...message, createdAt: message.createdAt || new Date().toISOString() })],
      };
      if (message.role === 'user') {
        next.workingMemory = {
          ...(next.workingMemory || {}),
          lastUserGoal: String(message.content || '').trim(),
          summary: summarizeMemory(next.messages),
        };
      }
      if (message.artifact) next.artifact = message.artifact;
      if (message.trace) next.trace = message.trace;
      return save(next);
    },



    async listRequests({ userId, limit = 50 } = {}) {
      await ensureDir();
      const owner = normalizeUserId(userId || 'anon');
      let names = [];
      try { names = await readdir(dir); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
      const out = [];
      for (const name of names) {
        if (!name.endsWith('.json')) continue;
        const session = await this.get(name.slice(0, -5), { userId: owner });
        if (!session) continue;
        const messages = session.messages || [];
        for (let index = 0; index < messages.length; index += 1) {
          const message = messages[index];
          if (message.role !== 'user') continue;
          const title = normalizeRequestTitle(message.content);
          if (!title) continue;
          const answer = messages.slice(index + 1).find((item) => item.role === 'assistant');
          const question = compactHistoryText(message.content, 500);
          const finalAnswer = compactHistoryText(answer?.content || answer?.artifact?.memo?.summary || '', 900);
          const createdAt = message.createdAt || session.createdAt;
          out.push({
            sessionId: session.id,
            title,
            question,
            finalAnswer,
            shareText: buildShareText({ question, finalAnswer }),
            createdAt,
            updatedAt: session.updatedAt,
            status: session.status,
          });
        }
      }
      return out.sort((a, b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0)).slice(0, Math.max(1, Math.min(Number(limit) || 50, 100)));
    },

    async clearRequests({ userId } = {}) {
      await ensureDir();
      const owner = normalizeUserId(userId || 'anon');
      if (owner === 'anon' || owner.startsWith('guest:')) return { deleted: 0 };
      let names = [];
      try { names = await readdir(dir); } catch (error) { if (error.code === 'ENOENT') return { deleted: 0 }; throw error; }
      let deleted = 0;
      for (const name of names) {
        if (!name.endsWith('.json')) continue;
        const id = name.slice(0, -5);
        const session = await this.get(id, { userId: owner });
        if (!session) continue;
        await unlink(fileFor(id));
        deleted += 1;
      }
      return { deleted };
    },


    async countUserMessagesSince({ userId, since } = {}) {
      await ensureDir();
      const owner = normalizeUserId(userId || 'anon');
      const sinceMs = Date.parse(since || 0) || 0;
      let names = [];
      try { names = await readdir(dir); } catch (error) { if (error.code === 'ENOENT') return 0; throw error; }
      let count = 0;
      for (const name of names) {
        if (!name.endsWith('.json')) continue;
        const session = await this.get(name.slice(0, -5), { userId: owner });
        if (!session) continue;
        for (const message of (session.messages || [])) {
          if (message?.role !== 'user') continue;
          const ts = Date.parse(message.createdAt || session.createdAt || 0) || 0;
          if (ts >= sinceMs) count += 1;
        }
      }
      return count;
    },

    async update(id, patch = {}) {
      const session = await this.get(id);
      if (!session) throw new Error('Agent session not found');
      return save({ ...session, ...sanitizeForStorage(patch) });
    },
  };
}


function normalizeUserId(value = 'anon') {
  return String(value || 'anon').trim().slice(0, 160).replace(/[^a-zA-Z0-9:_@.\-]/g, '_') || 'anon';
}

function normalizeRequestTitle(value = '') {
  const text = String(value || '').trim().replace(/\s+/g, ' ');
  if (!text || text.length < 12) return '';
  if (/^(hi|hello|hey|yo|thanks|thank you|ok|okay|gm|gn|hello|thanks|ok)$/i.test(text)) return '';
  if (!/(simulate|simulation|review|compare|rewrite|proof|launch|product|base|miroshark|report)/i.test(text)) return '';
  return text.slice(0, 140);
}

function compactHistoryText(value = '', max = 500) {
  const text = String(value || '').trim().replace(/\s+/g, ' ');
  return text.length > max ? `${text.slice(0, max - 3).trim()}...` : text;
}

function buildShareText({ question = '', finalAnswer = '' } = {}) {
  const parts = [`Question: ${compactHistoryText(question, 360)}`];
  if (finalAnswer) parts.push(`Synthetic: ${compactHistoryText(finalAnswer, 640)}`);
  return parts.join('\n\n');
}

function summarizeMemory(messages = []) {
  const latest = [...messages].reverse().find((item) => item.role === 'user');
  return latest ? `Current goal: ${String(latest.content || '').slice(0, 260)}` : '';
}

function isSafePublicTokenMetadataKey(key = '') {
  return ['tokenChart', 'tokenName', 'tokenSymbol', 'tokenAddress'].includes(String(key || ''));
}

export function sanitizeForStorage(value) {
  if (Array.isArray(value)) return value.map(sanitizeForStorage);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [key, val] of Object.entries(value)) {
    if (isSafePublicTokenMetadataKey(key)) {
      out[key] = sanitizeForStorage(val);
    } else if (SECRET_KEY_PATTERN.test(key)) {
      out[key] = '[REDACTED]';
    } else {
      out[key] = sanitizeForStorage(val);
    }
  }
  return out;
}
