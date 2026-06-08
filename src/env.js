import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

function parseEnvLine(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;
  const index = trimmed.indexOf('=');
  if (index === -1) return null;
  const key = trimmed.slice(0, index).trim();
  let value = trimmed.slice(index + 1).trim();
  if (!key) return null;
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  return [key, value];
}

export function loadLocalEnv(options = {}) {
  const envPath = options.envPath || path.join(projectRoot, '.env.local');
  if (!fs.existsSync(envPath)) return { loaded: false, envPath };
  const text = fs.readFileSync(envPath, 'utf8');
  let count = 0;
  for (const line of text.split(/\r?\n/)) {
    const parsed = parseEnvLine(line);
    if (!parsed) continue;
    const [key, value] = parsed;
    if (process.env[key] === undefined && value !== '') {
      process.env[key] = value;
      count += 1;
    }
  }
  return { loaded: true, envPath, count };
}
