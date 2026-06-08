import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

export function createOpenWorldJobStore({ dir, now = () => Date.now() } = {}) {
  if (!dir) throw new Error('open-world job store requires dir');

  const read = async (id) => {
    const file = jobPath(dir, id);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return parseJobJson(await readFile(file, 'utf8'));
      } catch (error) {
        if (error?.code === 'ENOENT') return null;
        if (!(error instanceof SyntaxError) || attempt === 2) throw error;
        await sleep(25 * (attempt + 1));
      }
    }
    return null;
  };

  const persist = async (job) => {
    await mkdir(dir, { recursive: true });
    const file = jobPath(dir, job.id);
    const tmp = `${file}.${process.pid}.${Date.now()}.${randomBytes(4).toString('hex')}.tmp`;
    await writeFile(tmp, `${JSON.stringify(job, null, 2)}\n`, 'utf8');
    await rename(tmp, file);
    return job;
  };

  return {
    async create({ input, metadata = {} } = {}) {
      const timestamp = now();
      const job = {
        ok: true,
        id: `ow_${timestamp.toString(36)}_${randomBytes(4).toString('hex')}`,
        input: String(input || '').trim(),
        status: 'queued',
        step: 'queued',
        message: 'Queued',
        metadata,
        createdAt: new Date(timestamp).toISOString(),
        updatedAt: new Date(timestamp).toISOString(),
      };
      return persist(job);
    },

    get: read,

    async update(id, patch = {}) {
      const current = await read(id);
      if (!current) return null;
      return persist({
        ...current,
        ...patch,
        id: current.id,
        input: current.input,
        updatedAt: new Date(now()).toISOString(),
      });
    },

    async complete(id, { result, share, miroshark } = {}) {
      const current = await read(id);
      if (!current) return null;
      const timestamp = now();
      return persist({
        ...current,
        status: 'completed',
        step: 'completed',
        message: 'Completed',
        result,
        share,
        miroshark,
        completedAt: new Date(timestamp).toISOString(),
        updatedAt: new Date(timestamp).toISOString(),
      });
    },

    async fail(id, error) {
      const current = await read(id);
      if (!current) return null;
      const timestamp = now();
      return persist({
        ...current,
        ok: false,
        status: 'failed',
        step: 'failed',
        message: 'Failed',
        error: error instanceof Error ? error.message : String(error || 'Unknown error'),
        failedAt: new Date(timestamp).toISOString(),
        updatedAt: new Date(timestamp).toISOString(),
      });
    },

    async findReusableCompleted({ cacheKey, ttlMs = 0 } = {}) {
      if (!cacheKey || ttlMs <= 0) return null;
      let names = [];
      try {
        names = await readdir(dir);
      } catch (error) {
        if (error?.code === 'ENOENT') return null;
        throw error;
      }
      const cutoff = now() - ttlMs;
      const matches = [];
      for (const name of names) {
        if (!name.endsWith('.json')) continue;
        const id = name.slice(0, -5);
        const job = await read(id);
        if (!job || job.status !== 'completed') continue;
        if (job.metadata?.cacheKey !== cacheKey) continue;
        if (job.metadata?.cacheHit) continue;
        if (!job.result || !job.share) continue;
        if (job.result?.degradedSharkMode) continue;
        const completedMs = Date.parse(job.completedAt || job.updatedAt || job.createdAt || 0);
        if (!Number.isFinite(completedMs) || completedMs < cutoff) continue;
        matches.push(job);
      }
      matches.sort((a, b) => Date.parse(b.completedAt || b.updatedAt || 0) - Date.parse(a.completedAt || a.updatedAt || 0));
      return matches[0] || null;
    },

    async createCachedHit({ input, source, metadata = {} } = {}) {
      if (!source || source.status !== 'completed' || !source.result || !source.share) {
        throw new Error('cache hit source must be a completed job with result and share');
      }
      const timestamp = now();
      const job = {
        ok: true,
        id: `ow_${timestamp.toString(36)}_${randomBytes(4).toString('hex')}`,
        input: String(input || source.input || '').trim(),
        status: 'completed',
        step: 'cached',
        message: 'Loaded from cache',
        metadata: {
          ...metadata,
          cacheHit: true,
          cacheSourceJobId: source.id,
          cacheSourceCompletedAt: source.completedAt,
        },
        progress: source.progress ? { ...source.progress, percent: 100, label: 'cached result' } : { percent: 100, label: 'cached result' },
        result: source.result,
        share: source.share,
        miroshark: source.miroshark,
        createdAt: new Date(timestamp).toISOString(),
        updatedAt: new Date(timestamp).toISOString(),
        completedAt: new Date(timestamp).toISOString(),
      };
      return persist(job);
    },
  };
}

function jobPath(dir, id) {
  const safe = String(id || '').replace(/[^a-zA-Z0-9_-]/g, '');
  if (!safe) throw new Error('invalid open-world job id');
  return path.join(dir, `${safe}.json`);
}

function parseJobJson(text) {
  try {
    return JSON.parse(text);
  } catch (error) {
    const recovered = parseFirstJsonObject(text);
    if (recovered) return recovered;
    throw error;
  }
}

function parseFirstJsonObject(text) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  let started = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (!started) {
      if (/\s/.test(char)) continue;
      if (char !== '{') return null;
      started = true;
      depth = 1;
      continue;
    }

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
    } else if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(0, index + 1));
        } catch {
          return null;
        }
      }
    }
  }

  return null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
