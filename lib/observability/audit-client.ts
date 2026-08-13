import {
  AUDIT_ATTEMPT_HEADER,
  AUDIT_RUN_HEADER,
  AUDIT_SCENE_ORDER_HEADER,
  AUDIT_SCENE_OUTLINE_HEADER,
  AUDIT_SCENE_STAGE_HEADER,
  AUDIT_SCENE_TOTAL_HEADER,
  createAuditRunId,
  type AuditSceneMetadata,
} from './audit-types';

const DEFAULT_SCOPE = 'default';

function storageKey(scope: string): string {
  return `openmaic.auditRunId.${scope}`;
}

function readStored(scope: string): string | undefined {
  try {
    return sessionStorage.getItem(storageKey(scope)) ?? undefined;
  } catch {
    return undefined;
  }
}

export function beginAuditRun(scope = DEFAULT_SCOPE, auditRunId = createAuditRunId()): string {
  try {
    sessionStorage.setItem(storageKey(scope), auditRunId);
  } catch {
    // The request can still carry the in-memory ID when storage is unavailable.
  }
  return auditRunId;
}

export function getAuditRunId(scope = DEFAULT_SCOPE): string {
  return readStored(scope) ?? beginAuditRun(scope);
}

export function clearAuditRun(scope = DEFAULT_SCOPE): void {
  try {
    sessionStorage.removeItem(storageKey(scope));
  } catch {
    // Ignore storage restrictions in private browsing or non-browser tests.
  }
}

export function getAuditHeaders(scope = DEFAULT_SCOPE, attempt?: number): Record<string, string> {
  const headers: Record<string, string> = {
    [AUDIT_RUN_HEADER]: getAuditRunId(scope),
  };
  if (attempt !== undefined) headers[AUDIT_ATTEMPT_HEADER] = String(attempt);
  return headers;
}

function sceneHeaders(scene?: AuditSceneMetadata): Record<string, string> {
  if (!scene) return {};

  return {
    ...(scene.stageId ? { [AUDIT_SCENE_STAGE_HEADER]: scene.stageId } : {}),
    ...(scene.outlineId ? { [AUDIT_SCENE_OUTLINE_HEADER]: scene.outlineId } : {}),
    ...(scene.sceneOrder !== undefined
      ? { [AUDIT_SCENE_ORDER_HEADER]: String(scene.sceneOrder) }
      : {}),
    ...(scene.totalScenes !== undefined
      ? { [AUDIT_SCENE_TOTAL_HEADER]: String(scene.totalScenes) }
      : {}),
  };
}

export function mergeAuditHeaders(
  init: HeadersInit | undefined,
  scope = DEFAULT_SCOPE,
  attempt?: number,
  scene?: AuditSceneMetadata,
): Record<string, string> {
  const headers = new Headers(init);
  for (const [key, value] of Object.entries({
    ...getAuditHeaders(scope, attempt),
    ...sceneHeaders(scene),
  })) {
    headers.set(key, value);
  }
  return Object.fromEntries(headers.entries());
}
