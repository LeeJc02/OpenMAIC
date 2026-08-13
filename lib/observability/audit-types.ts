/** Shared audit-trace wire types and client-safe helpers. */

export const AUDIT_RUN_HEADER = 'x-openmaic-audit-run-id';
export const AUDIT_ATTEMPT_HEADER = 'x-openmaic-audit-attempt';
export const AUDIT_SCENE_STAGE_HEADER = 'x-openmaic-audit-stage-id';
export const AUDIT_SCENE_OUTLINE_HEADER = 'x-openmaic-audit-outline-id';
export const AUDIT_SCENE_ORDER_HEADER = 'x-openmaic-audit-scene-order';
export const AUDIT_SCENE_TOTAL_HEADER = 'x-openmaic-audit-scene-total';

export type AuditModule = 'generation' | 'langgraph' | 'pbl' | 'external';

export type AuditStatus = 'started' | 'completed' | 'error' | 'aborted' | 'timeout';

export type AuditAttribute = string | number | boolean | string[] | number[] | boolean[];

export interface AuditContext {
  auditRunId: string;
  module: AuditModule;
  operation: string;
  sessionId?: string;
  stageId?: string;
  sceneId?: string;
  outlineId?: string;
  agentId?: string;
  projectId?: string;
  milestoneId?: string;
  microtaskId?: string;
  turnIndex?: number;
  attempt?: number;
  promptId?: string;
  promptVersion?: string;
  sceneOrder?: number;
  totalScenes?: number;
  sceneTitle?: string;
}

export type AuditSceneMetadata = Pick<
  AuditContext,
  'stageId' | 'outlineId' | 'sceneOrder' | 'totalScenes'
>;

export interface AuditEvent {
  schemaVersion: 1;
  eventId: string;
  auditRunId: string;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  module: AuditModule;
  operation: string;
  node: string;
  eventType: string;
  status: AuditStatus;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  input?: unknown;
  output?: unknown;
  stateBefore?: unknown;
  stateAfter?: unknown;
  stateDiff?: unknown;
  usage?: unknown;
  error?: unknown;
  attributes?: Record<string, unknown>;
}

export interface AuditSpanOptions {
  name: string;
  node: string;
  context?: Partial<AuditContext>;
  attributes?: Record<string, unknown>;
  input?: unknown;
  stateBefore?: unknown;
  eventType?: string;
}

export interface AuditSpanEndOptions {
  status?: Exclude<AuditStatus, 'started'>;
  output?: unknown;
  stateAfter?: unknown;
  stateDiff?: unknown;
  usage?: unknown;
  error?: unknown;
  attributes?: Record<string, unknown>;
  eventType?: string;
}

export interface AuditRequestOptions {
  module: AuditModule;
  operation: string;
  node?: string;
  context?: Partial<AuditContext>;
  attributes?: Record<string, unknown>;
}

/** Generate an ID without importing a server-only dependency. */
export function createAuditRunId(): string {
  const randomUuid = globalThis.crypto?.randomUUID?.();
  if (randomUuid) return `audit_${randomUuid.replaceAll('-', '')}`;

  const random = Math.random().toString(36).slice(2, 12);
  return `audit_${Date.now().toString(36)}_${random}`;
}

export function isValidAuditRunId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}
