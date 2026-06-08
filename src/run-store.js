import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export function createRunStore(options = {}) {
  const memoryOnly = options.memoryOnly === true;
  const dir = options.dir || path.resolve(process.cwd(), '.synthetic-runs');
  const memory = new Map();

  return {
    async save(result) {
      const id = makeRunId(result);
      const record = {
        id,
        url: `/r/${id}`,
        createdAt: new Date().toISOString(),
        summary: summarize(result),
        result,
      };
      if (memoryOnly) {
        memory.set(id, record);
        return record;
      }
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, `${id}.json`), JSON.stringify(record, null, 2));
      return record;
    },

    async get(id) {
      if (!/^run_[a-z0-9]{12}$/.test(id || '')) return null;
      if (memoryOnly) return memory.get(id) || null;
      try {
        const raw = await readFile(path.join(dir, `${id}.json`), 'utf8');
        return JSON.parse(raw);
      } catch {
        return null;
      }
    },
  };
}

function makeRunId(result) {
  const seed = JSON.stringify({ input: result.input, intent: result.intent, generatedAt: result.generatedAt, score: result.memo?.score });
  return `run_${crypto.createHash('sha256').update(seed).digest('base64url').replace(/[-_]/g, '').toLowerCase().slice(0, 12)}`;
}

function summarize(result) {
  return {
    input: result.input,
    intent: result.intent?.intent,
    score: result.memo?.score,
    verdict: result.memo?.verdict,
    title: result.memo?.marketQuestion,
  };
}
