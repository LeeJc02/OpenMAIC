import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomBytes } from 'node:crypto';
import {
  context as otelContext,
  SpanStatusCode,
  trace,
  type Attributes,
  type Context,
  type Span,
} from '@opentelemetry/api';
import { appendAuditEvent } from './audit-sink';
import {
  AUDIT_ATTEMPT_HEADER,
  AUDIT_RUN_HEADER,
  AUDIT_SCENE_ORDER_HEADER,
  AUDIT_SCENE_OUTLINE_HEADER,
  AUDIT_SCENE_STAGE_HEADER,
  AUDIT_SCENE_TOTAL_HEADER,
  createAuditRunId,
  isValidAuditRunId,
  type AuditAttribute,
  type AuditContext,
  type AuditEvent,
  type AuditRequestOptions,
  type AuditSpanEndOptions,
  type AuditSpanOptions,
  type AuditStatus,
} from './audit-types';

interface AuditState {
  context: AuditContext;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  span?: Span;
  otelContext: Context;
  startedAt: string;
}

export interface AuditSpanHandle {
  readonly context: AuditContext;
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId?: string;
  run<T>(callback: () => T): T;
  end(options?: AuditSpanEndOptions): void;
}

const auditStorage = new AsyncLocalStorage<AuditState>();
const tracer = trace.getTracer('openmaic.audit', '0.1.0');

function enabled(): boolean {
  const value = process.env.OPENMAIC_AUDIT_TRACE?.trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}

export function isAuditEnabled(): boolean {
  return enabled();
}

function randomHex(bytes: number): string {
  return randomBytes(bytes).toString('hex');
}

function validTraceId(value: string): boolean {
  return /^[0-9a-f]{32}$/.test(value) && !/^0+$/.test(value);
}

function validSpanId(value: string): boolean {
  return /^[0-9a-f]{16}$/.test(value) && !/^0+$/.test(value);
}

function attributeValue(value: unknown): AuditAttribute | undefined {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
    return value as string[];
  }
  if (Array.isArray(value) && value.every((item) => typeof item === 'number')) {
    return value as number[];
  }
  if (Array.isArray(value) && value.every((item) => typeof item === 'boolean')) {
    return value as boolean[];
  }
  return undefined;
}

function otelAttributes(attributes: Record<string, unknown> | undefined): Attributes {
  const result: Attributes = {};
  for (const [key, value] of Object.entries(attributes ?? {})) {
    const normalized = attributeValue(value);
    if (normalized !== undefined) result[key] = normalized;
  }
  return result;
}

function errorValue(error: unknown): unknown {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack };
  }
  return error;
}

function now(): string {
  return new Date().toISOString();
}

function eventId(): string {
  return `evt_${createAuditRunId().slice(6)}`;
}

function currentState(): AuditState | undefined {
  return auditStorage.getStore();
}

function baseContext(options: AuditSpanOptions, parent?: AuditState): AuditContext {
  const inherited = parent?.context;
  const context = {
    ...inherited,
    ...options.context,
  } as AuditContext;
  if (!context.auditRunId) context.auditRunId = createAuditRunId();
  if (!context.module) context.module = 'external';
  if (!context.operation) context.operation = options.name;
  return context;
}

function createEvent(
  state: AuditState,
  options: AuditSpanOptions,
  endedAt: string,
  durationMs: number,
  end: AuditSpanEndOptions,
): AuditEvent {
  return {
    schemaVersion: 1,
    eventId: eventId(),
    auditRunId: state.context.auditRunId,
    traceId: state.traceId,
    spanId: state.spanId,
    ...(state.parentSpanId ? { parentSpanId: state.parentSpanId } : {}),
    module: state.context.module,
    operation: state.context.operation,
    node: options.node,
    eventType: end.eventType ?? options.eventType ?? 'span',
    status: end.status ?? 'completed',
    startedAt: state.startedAt,
    endedAt,
    durationMs,
    ...(options.input !== undefined ? { input: options.input } : {}),
    ...(end.output !== undefined ? { output: end.output } : {}),
    ...(options.stateBefore !== undefined ? { stateBefore: options.stateBefore } : {}),
    ...(end.stateAfter !== undefined ? { stateAfter: end.stateAfter } : {}),
    ...(end.stateDiff !== undefined ? { stateDiff: end.stateDiff } : {}),
    ...(end.usage !== undefined ? { usage: end.usage } : {}),
    ...(end.error !== undefined ? { error: errorValue(end.error) } : {}),
    attributes: {
      ...options.attributes,
      ...end.attributes,
      ...state.context,
    },
  };
}

export function startAuditSpan(options: AuditSpanOptions): AuditSpanHandle {
  const parent = currentState();
  const context = baseContext(options, parent);
  const parentOtelContext = otelContext.active();
  const span = enabled()
    ? tracer.startSpan(
        options.name,
        { attributes: otelAttributes(options.attributes) },
        parentOtelContext,
      )
    : undefined;
  const spanContext = span?.spanContext();
  const traceId =
    spanContext && validTraceId(spanContext.traceId)
      ? spanContext.traceId
      : parent?.traceId && validTraceId(parent.traceId)
        ? parent.traceId
        : randomHex(16);
  const spanId = spanContext && validSpanId(spanContext.spanId) ? spanContext.spanId : randomHex(8);
  const nextState: AuditState = {
    context,
    traceId,
    spanId,
    parentSpanId: parent?.spanId,
    span,
    otelContext: span ? trace.setSpan(parentOtelContext, span) : parentOtelContext,
    startedAt: now(),
  };
  let ended = false;

  return {
    context,
    traceId,
    spanId,
    parentSpanId: parent?.spanId,
    run<T>(callback: () => T): T {
      return auditStorage.run(nextState, () =>
        span ? otelContext.with(nextState.otelContext, callback) : callback(),
      );
    },
    end(end: AuditSpanEndOptions = {}): void {
      if (ended) return;
      ended = true;
      const endedAt = now();
      const durationMs = Math.max(0, Date.parse(endedAt) - Date.parse(nextState.startedAt));
      const status: AuditStatus = end.status ?? 'completed';
      if (span) {
        if (status === 'error' || status === 'timeout') {
          if (end.error !== undefined) {
            span.recordException(errorValue(end.error) as Error);
          }
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: end.error instanceof Error ? end.error.message : undefined,
          });
        } else {
          span.setStatus({ code: SpanStatusCode.OK });
        }
        span.setAttributes(
          otelAttributes({
            ...options.attributes,
            ...end.attributes,
            'openmaic.audit_run_id': context.auditRunId,
            'openmaic.audit_status': status,
            'openmaic.duration_ms': durationMs,
          }),
        );
        span.end();
      }
      appendAuditEvent(createEvent(nextState, options, endedAt, durationMs, { ...end, status }));
    },
  };
}

export async function withAuditSpan<T>(
  options: AuditSpanOptions,
  callback: (span: AuditSpanHandle) => Promise<T> | T,
): Promise<T> {
  const span = startAuditSpan(options);
  try {
    const result = await span.run(() => callback(span));
    span.end();
    return result;
  } catch (error) {
    span.end({ status: 'error', error });
    throw error;
  }
}

export function withAuditContext<T>(patch: Partial<AuditContext>, callback: () => T): T {
  if (!enabled()) return callback();
  const current = currentState();
  if (!current) {
    const context = {
      auditRunId: patch.auditRunId ?? createAuditRunId(),
      module: patch.module ?? 'external',
      operation: patch.operation ?? 'request',
      ...patch,
    } as AuditContext;
    const state: AuditState = {
      context,
      traceId: randomHex(16),
      spanId: randomHex(8),
      otelContext: otelContext.active(),
      startedAt: now(),
    };
    return auditStorage.run(state, callback);
  }
  return auditStorage.run(
    {
      ...current,
      context: { ...current.context, ...patch },
    },
    callback,
  );
}

export function currentAuditContext(): AuditContext | undefined {
  return currentState()?.context;
}

export function currentAuditRunId(): string | undefined {
  return currentState()?.context.auditRunId;
}

export function recordAuditEvent(
  eventType: string,
  payload: {
    input?: unknown;
    output?: unknown;
    stateBefore?: unknown;
    stateAfter?: unknown;
    stateDiff?: unknown;
    status?: Exclude<AuditStatus, 'started'>;
    attributes?: Record<string, unknown>;
  } = {},
): void {
  const state = currentState();
  if (!enabled() || !state) return;
  const timestamp = now();
  appendAuditEvent({
    schemaVersion: 1,
    eventId: eventId(),
    auditRunId: state.context.auditRunId,
    traceId: state.traceId,
    spanId: state.spanId,
    ...(state.parentSpanId ? { parentSpanId: state.parentSpanId } : {}),
    module: state.context.module,
    operation: state.context.operation,
    node: 'event',
    eventType,
    status: payload.status ?? 'completed',
    startedAt: timestamp,
    endedAt: timestamp,
    durationMs: 0,
    ...(payload.input !== undefined ? { input: payload.input } : {}),
    ...(payload.output !== undefined ? { output: payload.output } : {}),
    ...(payload.stateBefore !== undefined ? { stateBefore: payload.stateBefore } : {}),
    ...(payload.stateAfter !== undefined ? { stateAfter: payload.stateAfter } : {}),
    ...(payload.stateDiff !== undefined ? { stateDiff: payload.stateDiff } : {}),
    attributes: { ...state.context, ...payload.attributes },
  });
}

type AuditRequestHeaders = Pick<Headers, 'get'>;

function requestHeaders(req: { headers?: AuditRequestHeaders }): AuditRequestHeaders {
  return req.headers ?? new Headers();
}

export function auditRequestId(req: { headers?: AuditRequestHeaders }): string {
  const incoming = requestHeaders(req).get(AUDIT_RUN_HEADER);
  return isValidAuditRunId(incoming) ? incoming : createAuditRunId();
}

export function auditAttempt(req: { headers?: AuditRequestHeaders }): number | undefined {
  const value = requestHeaders(req).get(AUDIT_ATTEMPT_HEADER);
  if (!value) return undefined;
  const attempt = Number(value);
  return Number.isInteger(attempt) && attempt > 0 ? attempt : undefined;
}

function auditSceneContext(req: { headers?: AuditRequestHeaders }): Partial<AuditContext> {
  const headers = requestHeaders(req);
  const sceneOrder = Number(headers.get(AUDIT_SCENE_ORDER_HEADER));
  const totalScenes = Number(headers.get(AUDIT_SCENE_TOTAL_HEADER));
  return {
    ...(headers.get(AUDIT_SCENE_STAGE_HEADER)?.trim()
      ? { stageId: headers.get(AUDIT_SCENE_STAGE_HEADER)!.trim().slice(0, 128) }
      : {}),
    ...(headers.get(AUDIT_SCENE_OUTLINE_HEADER)?.trim()
      ? { outlineId: headers.get(AUDIT_SCENE_OUTLINE_HEADER)!.trim().slice(0, 128) }
      : {}),
    ...(Number.isInteger(sceneOrder) && sceneOrder > 0 ? { sceneOrder } : {}),
    ...(Number.isInteger(totalScenes) && totalScenes > 0 ? { totalScenes } : {}),
  };
}

export function startAuditRequest(
  req: { headers?: AuditRequestHeaders },
  options: AuditRequestOptions,
): AuditSpanHandle & { headers: Record<string, string> } {
  const auditRunId = auditRequestId(req);
  const attempt = auditAttempt(req);
  const span = startAuditSpan({
    name: `http.${options.operation}`,
    node: options.node ?? 'request',
    context: {
      ...options.context,
      ...auditSceneContext(req),
      auditRunId,
      module: options.module,
      operation: options.operation,
      ...(attempt !== undefined ? { attempt } : {}),
    },
    attributes: {
      ...options.attributes,
      'openmaic.audit_run_id': auditRunId,
      ...(attempt !== undefined ? { 'openmaic.attempt': attempt } : {}),
    },
  });
  return {
    ...span,
    headers: { [AUDIT_RUN_HEADER]: auditRunId },
  };
}

export function applyAuditResponseHeaders<T extends Response>(
  response: T,
  audit: AuditSpanHandle,
): T {
  if (enabled()) {
    response.headers.set(AUDIT_RUN_HEADER, audit.context.auditRunId);
    response.headers.set('x-openmaic-audit-trace-id', audit.traceId);
  }
  return response;
}

export async function withAuditedRequest<T extends Response>(
  req: { headers?: AuditRequestHeaders },
  options: AuditRequestOptions,
  callback: (audit: AuditSpanHandle) => Promise<T> | T,
): Promise<T> {
  const audit = startAuditRequest(req, options);
  try {
    const response = await audit.run(() => callback(audit));
    audit.end({
      status: response.status >= 400 ? 'error' : 'completed',
      eventType: response.status >= 400 ? 'http.error' : 'http.completed',
      attributes: { httpStatusCode: response.status },
    });
    return applyAuditResponseHeaders(response, audit);
  } catch (error) {
    audit.end({ status: 'error', error, eventType: 'http.error' });
    throw error;
  }
}

/**
 * Start a request span whose lifetime is owned by a streaming response.
 * Non-streaming responses are completed here; SSE responses are completed by
 * the stream helper after the generator terminates.
 */
export async function withAuditedStreamRequest<T extends Response>(
  req: { headers?: AuditRequestHeaders },
  options: AuditRequestOptions,
  callback: (audit: AuditSpanHandle) => Promise<T> | T,
): Promise<T> {
  const audit = startAuditRequest(req, options);
  try {
    const response = await audit.run(() => callback(audit));
    const isStreaming = response.headers.get('content-type')?.includes('text/event-stream');
    if (!isStreaming) {
      audit.end({
        status: response.status >= 400 ? 'error' : 'completed',
        eventType: response.status >= 400 ? 'http.error' : 'http.completed',
        attributes: { httpStatusCode: response.status },
      });
    }
    return applyAuditResponseHeaders(response, audit);
  } catch (error) {
    audit.end({ status: 'error', error, eventType: 'http.error' });
    throw error;
  }
}

export function hashAuditPayload(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
}
