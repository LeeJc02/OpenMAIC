import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { AuditEvent } from './audit-types';

const queues = new Map<string, Promise<void>>();

function isAuditEnabled(): boolean {
  const value = process.env.OPENMAIC_AUDIT_TRACE?.trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}

export function auditTraceDir(): string {
  return path.resolve(
    process.env.OPENMAIC_AUDIT_TRACE_DIR || path.join(process.cwd(), 'data', 'audit-traces'),
  );
}

function safeRunId(auditRunId: string): string {
  return auditRunId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 128) || 'unknown';
}

export function auditRunDir(auditRunId: string): string {
  return path.join(auditTraceDir(), safeRunId(auditRunId));
}

function sensitiveKey(key: string): boolean {
  const normalized = key.replaceAll('-', '').replaceAll('_', '').toLowerCase();
  return (
    normalized === 'authorization' ||
    normalized === 'cookie' ||
    normalized === 'cookies' ||
    normalized.includes('password') ||
    normalized.endsWith('apikey') ||
    normalized.endsWith('secret') ||
    normalized === 'token' ||
    normalized === 'accesstoken' ||
    normalized === 'refreshtoken' ||
    normalized === 'idtoken' ||
    normalized === 'bearertoken'
  );
}

function sanitizeString(value: string): unknown {
  if (value.startsWith('data:') && value.includes(';base64,')) {
    return { type: 'binary', encoding: 'data-url', length: value.length };
  }
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/sk-[A-Za-z0-9_-]{12,}/g, '[REDACTED_API_KEY]');
}

function sanitizeValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value == null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return sanitizeString(value);
  if (depth > 8) return '[MAX_DEPTH]';

  if (typeof value === 'object') {
    if (value instanceof Uint8Array || value instanceof ArrayBuffer) {
      return {
        type: 'binary',
        bytes: value instanceof Uint8Array ? value.byteLength : value.byteLength,
      };
    }
    if (seen.has(value)) return '[CIRCULAR]';
    seen.add(value);
    if (Array.isArray(value)) {
      return value.map((item) => sanitizeValue(item, depth + 1, seen));
    }
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      output[key] = sensitiveKey(key) ? '[REDACTED]' : sanitizeValue(item, depth + 1, seen);
    }
    return output;
  }

  return String(value);
}

export function sanitizeAuditValue(value: unknown): unknown {
  return sanitizeValue(value, 0, new WeakSet<object>());
}

async function appendLine(auditRunId: string, event: AuditEvent): Promise<void> {
  const dir = auditRunDir(auditRunId);
  await fs.mkdir(dir, { recursive: true });
  await fs.appendFile(
    path.join(dir, 'events.jsonl'),
    `${JSON.stringify(sanitizeAuditValue(event))}\n`,
    'utf8',
  );
}

/** Fire-and-forget sink; failures never affect the generation request. */
export function appendAuditEvent(event: AuditEvent): void {
  if (!isAuditEnabled()) return;

  const previous = queues.get(event.auditRunId) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(() => appendLine(event.auditRunId, event))
    .catch(() => undefined);
  queues.set(event.auditRunId, next);
  void next.finally(() => {
    if (queues.get(event.auditRunId) === next) queues.delete(event.auditRunId);
  });
}

export async function flushAuditEvents(auditRunId?: string): Promise<void> {
  if (auditRunId) {
    await queues.get(auditRunId);
    return;
  }
  await Promise.all([...queues.values()]);
}

export async function readAuditEvents(auditRunId: string): Promise<AuditEvent[]> {
  const file = path.join(auditRunDir(auditRunId), 'events.jsonl');
  const text = await fs.readFile(file, 'utf8');
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as AuditEvent);
}
