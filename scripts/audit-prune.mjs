import { promises as fs } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');

function option(name, fallback) {
  const index = args.indexOf(name);
  if (index < 0 || !args[index + 1]) return fallback;
  const value = Number(args[index + 1]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

const rootDir = path.resolve(
  process.env.OPENMAIC_AUDIT_TRACE_DIR || path.join(process.cwd(), 'data', 'audit-traces'),
);
const retentionDays = option('--days', Number(process.env.OPENMAIC_AUDIT_RETENTION_DAYS || 30));
const maxBytes = option(
  '--max-bytes',
  Number(process.env.OPENMAIC_AUDIT_MAX_BYTES || 10 * 1024 * 1024 * 1024),
);

async function directorySize(dir) {
  let total = 0;
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) total += await directorySize(file);
    else if (entry.isFile()) total += (await fs.stat(file)).size;
  }
  return total;
}

let rootStat;
try {
  rootStat = await fs.lstat(rootDir);
} catch {
  console.log(`Audit directory does not exist: ${rootDir}`);
  process.exit(0);
}
if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
  throw new Error(`Audit trace path is not a real directory: ${rootDir}`);
}

const runs = [];
for (const entry of await fs.readdir(rootDir, { withFileTypes: true })) {
  if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
  const runDir = path.join(rootDir, entry.name);
  const stat = await fs.stat(runDir);
  runs.push({
    runId: entry.name,
    path: runDir,
    mtimeMs: stat.mtimeMs,
    bytes: await directorySize(runDir),
  });
}
runs.sort((a, b) => a.mtimeMs - b.mtimeMs);

const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
const remove = new Set(runs.filter((run) => run.mtimeMs < cutoff));
let totalBytes = runs.reduce((sum, run) => sum + run.bytes, 0);
for (const run of runs) {
  if (totalBytes <= maxBytes) break;
  if (remove.has(run)) continue;
  remove.add(run);
  totalBytes -= run.bytes;
}

for (const run of remove) {
  console.log(`${dryRun ? 'Would remove' : 'Removing'} ${run.runId} (${run.bytes} bytes)`);
  if (!dryRun) await fs.rm(run.path, { recursive: true, force: true });
}

console.log(
  `${dryRun ? 'Would remove' : 'Removed'} ${remove.size} run(s); ${runs.length - remove.size} remain under ${rootDir}.`,
);
