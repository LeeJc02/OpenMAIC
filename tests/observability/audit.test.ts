import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  flushAuditEvents,
  readAuditEvents,
  sanitizeAuditValue,
} from '@/lib/observability/audit-sink';
import {
  auditRequestId,
  hashAuditPayload,
  recordAuditEvent,
  startAuditRequest,
  startAuditSpan,
} from '@/lib/observability/audit';
import {
  AUDIT_SCENE_ORDER_HEADER,
  createAuditRunId,
  isValidAuditRunId,
} from '@/lib/observability/audit-types';
import { createSSEResponse } from '@/lib/pbl/v2/api/sse';
import type { PBLSSEEvent } from '@/lib/pbl/v2/api/sse';

describe('audit trace', () => {
  let traceDir: string;
  let previousEnabled: string | undefined;
  let previousDir: string | undefined;

  beforeEach(async () => {
    previousEnabled = process.env.OPENMAIC_AUDIT_TRACE;
    previousDir = process.env.OPENMAIC_AUDIT_TRACE_DIR;
    traceDir = await mkdtemp(join(tmpdir(), 'openmaic-audit-'));
    process.env.OPENMAIC_AUDIT_TRACE = 'true';
    process.env.OPENMAIC_AUDIT_TRACE_DIR = traceDir;
  });

  afterEach(async () => {
    if (previousEnabled === undefined) delete process.env.OPENMAIC_AUDIT_TRACE;
    else process.env.OPENMAIC_AUDIT_TRACE = previousEnabled;
    if (previousDir === undefined) delete process.env.OPENMAIC_AUDIT_TRACE_DIR;
    else process.env.OPENMAIC_AUDIT_TRACE_DIR = previousDir;
    await rm(traceDir, { recursive: true, force: true });
  });

  it('creates valid run ids and hashes logical payloads', () => {
    const runId = createAuditRunId();
    expect(isValidAuditRunId(runId)).toBe(true);
    expect(hashAuditPayload({ prompt: 'hello' })).toMatch(/^[0-9a-f]{16}$/);
  });

  it('redacts secrets and summarizes binary values', () => {
    const value = sanitizeAuditValue({
      apiKey: 'sk-test-secret-value',
      authorization: 'Bearer abc123',
      nested: { accessKeySecret: 'should-not-be-written' },
      binary: new Uint8Array([1, 2, 3]),
      text: 'Bearer another-secret',
    }) as Record<string, unknown>;

    expect(value.apiKey).toBe('[REDACTED]');
    expect(value.authorization).toBe('[REDACTED]');
    expect((value.nested as Record<string, unknown>).accessKeySecret).toBe('[REDACTED]');
    expect(value.binary).toEqual({ type: 'binary', bytes: 3 });
    expect(value.text).toBe('Bearer [REDACTED]');
  });

  it('writes nested spans and complete logical payloads to one run', async () => {
    const auditRunId = 'audit_test_run';
    const root = startAuditSpan({
      name: 'generation.test',
      node: 'request',
      context: { auditRunId, module: 'generation', operation: 'generation.test' },
      input: { prompt: 'full prompt', apiKey: 'not-persisted' },
    });

    root.run(() => {
      const child = startAuditSpan({
        name: 'generation.child',
        node: 'llm',
        input: { messages: [{ role: 'user', content: 'hello' }] },
      });
      recordAuditEvent('generation.state', {
        stateBefore: { phase: 'outline' },
        stateAfter: { phase: 'content' },
      });
      child.end({ output: { text: 'generated content' }, usage: { totalTokens: 12 } });
    });
    root.end({ output: { status: 'ok' } });

    await flushAuditEvents(auditRunId);
    const events = await readAuditEvents(auditRunId);
    expect(events).toHaveLength(3);
    expect(events.every((event) => event.auditRunId === auditRunId)).toBe(true);
    expect(
      events.some((event) => (JSON.stringify(event.output) ?? '').includes('generated content')),
    ).toBe(true);
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain('not-persisted');
    expect(serialized).toContain('full prompt');
  });

  it('finishes an SSE audit span after the stream is consumed', async () => {
    async function* events(): AsyncGenerator<PBLSSEEvent> {
      yield { type: 'token', delta: 'hello' };
      yield { type: 'done' };
    }

    const auditRunId = 'audit_sse_test';
    const audit = startAuditSpan({
      name: 'pbl.test',
      node: 'request',
      context: { auditRunId, module: 'pbl', operation: 'pbl.test' },
    });
    const response = createSSEResponse(events(), { audit });
    const body = await response.text();

    await flushAuditEvents(auditRunId);
    const traceEvents = await readAuditEvents(auditRunId);
    expect(body).toContain('event: token');
    expect(body).toContain('event: done');
    expect(traceEvents.some((event) => event.eventType === 'pbl.sse.done')).toBe(true);
    expect(traceEvents.some((event) => event.eventType === 'sse.completed')).toBe(true);
  });

  it('attaches scene metadata from request headers to every event in the request', async () => {
    const auditRunId = 'audit_scene_context';
    const request = {
      headers: new Headers({
        'x-openmaic-audit-run-id': auditRunId,
        'x-openmaic-audit-stage-id': 'stage-1',
        'x-openmaic-audit-outline-id': 'outline-7',
        [AUDIT_SCENE_ORDER_HEADER]: '7',
        'x-openmaic-audit-scene-total': '10',
      }),
    };

    expect(auditRequestId(request)).toBe(auditRunId);
    const audit = startAuditRequest(request, {
      module: 'generation',
      operation: 'generation.scene-content',
    });
    audit.end({ eventType: 'http.completed' });

    await flushAuditEvents(auditRunId);
    const [event] = await readAuditEvents(auditRunId);
    expect(event.attributes).toMatchObject({
      stageId: 'stage-1',
      outlineId: 'outline-7',
      sceneOrder: 7,
      totalScenes: 10,
    });
  });
});
