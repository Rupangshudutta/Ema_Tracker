// Fails when a file git tracks contains something that looks like a secret (fix for audit finding I4: a bot token
// once reached the public repository). Runs first in `npm run check`, so Cloudflare refuses to deploy such a commit.
// Prints file, line and kind only, never the value. Run: node scripts/secret-scan.ts
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { findSecrets } from './lib/secret-patterns.ts';

const ROOT = join(import.meta.dirname, '..');
const MAX_BYTES = 2 * 1024 * 1024;

/** Every file in the checkout except dependencies and tool state; used only where git is unavailable. */
function walk(dir: string, rel = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const path = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...walk(join(dir, entry.name), path));
    else if (entry.isFile()) out.push(path);
  }
  return out;
}
const SKIP_DIRS = new Set(['.git', 'node_modules', '.wrangler', 'logs']);

let files: string[];
try {
  files = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' }).split('\0').filter(Boolean);
} catch {
  console.log('secret scan: git is not available here, scanning the checked-out files instead');
  files = walk('.');
}
let findings = 0;
for (const file of files) {
  const path = join(ROOT, file);
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    continue; // deleted in the working tree but still in the index
  }
  if (size > MAX_BYTES) continue;
  const buf = readFileSync(path);
  if (buf.subarray(0, 8000).includes(0)) continue; // binary
  for (const f of findSecrets(buf.toString('utf8'))) {
    findings++;
    console.error(`secret scan: ${file}:${f.line} looks like a ${f.kind}`);
  }
}
if (findings) {
  console.error(`secret scan: ${findings} finding(s). Remove the value, keep it in Cloudflare secrets or .env.docker, and rotate it if it was ever pushed.`);
  process.exit(1);
}
console.log(`secret scan: ${files.length} tracked files clean`);
