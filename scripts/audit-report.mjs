import { promises as fs } from 'node:fs';
import path from 'node:path';

const runIdArg = process.argv.slice(2).find((arg) => !arg.startsWith('-'));
const rootDir = path.resolve(
  process.env.OPENMAIC_AUDIT_TRACE_DIR || path.join(process.cwd(), 'data', 'audit-traces'),
);

function assertRunId(value) {
  if (!value || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw new Error('Expected an audit run id containing only letters, numbers, _ or -.');
  }
  return value;
}

async function findRunId() {
  if (runIdArg) return assertRunId(runIdArg);
  const entries = await fs.readdir(rootDir, { withFileTypes: true });
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const file = path.join(rootDir, entry.name, 'events.jsonl');
    try {
      const stat = await fs.stat(file);
      candidates.push({ runId: entry.name, mtimeMs: stat.mtimeMs });
    } catch {
      // Ignore incomplete or manually removed runs.
    }
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  if (!candidates[0]) throw new Error(`No audit runs found under ${rootDir}`);
  return assertRunId(candidates[0].runId);
}

function escapeCell(value) {
  return String(value ?? '')
    .replaceAll('|', '\\|')
    .replaceAll('\n', ' ');
}

function preview(value, max = 1200) {
  if (value === undefined) return '';
  const text = JSON.stringify(value);
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

const runId = await findRunId();
const runDir = path.join(rootDir, runId);
const eventsFile = path.join(runDir, 'events.jsonl');
const text = await fs.readFile(eventsFile, 'utf8');
const events = text
  .split('\n')
  .filter(Boolean)
  .map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      throw new Error(`Invalid JSON on line ${index + 1}: ${error.message}`);
    }
  });

const statusCounts = new Map();
const eventCounts = new Map();
let durationMs = 0;
for (const event of events) {
  statusCounts.set(event.status, (statusCounts.get(event.status) || 0) + 1);
  eventCounts.set(event.eventType, (eventCounts.get(event.eventType) || 0) + 1);
  durationMs += Number(event.durationMs) || 0;
}

const lines = [
  `# OpenMAIC audit report: ${runId}`,
  '',
  `- Generated at: ${new Date().toISOString()}`,
  `- Event count: ${events.length}`,
  `- Recorded span duration: ${Math.round(durationMs)} ms`,
  '',
  '## Status summary',
  '',
  '| Status | Count |',
  '| --- | ---: |',
  ...[...statusCounts.entries()].map(([status, count]) => `| ${escapeCell(status)} | ${count} |`),
  '',
  '## Event types',
  '',
  '| Event type | Count |',
  '| --- | ---: |',
  ...[...eventCounts.entries()].map(([type, count]) => `| ${escapeCell(type)} | ${count} |`),
  '',
  '## Event index',
  '',
  '| # | Module | Operation | Node | Status | Duration |',
  '| ---: | --- | --- | --- | --- | ---: |',
  ...events.map(
    (event, index) =>
      `| ${index + 1} | ${escapeCell(event.module)} | ${escapeCell(event.operation)} | ${escapeCell(event.node)} | ${escapeCell(event.status)} | ${Number(event.durationMs) || 0} ms |`,
  ),
  '',
  '## Payload previews',
  '',
  '> Full logical input/output/state is retained in `events.jsonl`; this section is intentionally truncated for quick review.',
  '',
];

for (const [index, event] of events.entries()) {
  lines.push(`### ${index + 1}. ${event.eventType}`);
  lines.push('');
  lines.push(`- Span: \`${event.traceId}/${event.spanId}\``);
  if (event.input !== undefined) lines.push(`- Input: \`${preview(event.input)}\``);
  if (event.output !== undefined) lines.push(`- Output: \`${preview(event.output)}\``);
  if (event.stateBefore !== undefined)
    lines.push(`- State before: \`${preview(event.stateBefore)}\``);
  if (event.stateAfter !== undefined) lines.push(`- State after: \`${preview(event.stateAfter)}\``);
  if (event.stateDiff !== undefined) lines.push(`- State diff: \`${preview(event.stateDiff)}\``);
  if (event.usage !== undefined) lines.push(`- Usage: \`${preview(event.usage)}\``);
  if (event.error !== undefined) lines.push(`- Error: \`${preview(event.error)}\``);
  lines.push('');
}

const reportFile = path.join(runDir, 'summary.md');
await fs.writeFile(reportFile, `${lines.join('\n')}\n`, 'utf8');
console.log(`Wrote ${reportFile}`);
