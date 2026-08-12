import { AUDIT_ATTEMPT_HEADER, AUDIT_RUN_HEADER, createAuditRunId } from './audit-types';

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

export function mergeAuditHeaders(
  init: HeadersInit | undefined,
  scope = DEFAULT_SCOPE,
  attempt?: number,
): Record<string, string> {
  const headers = new Headers(init);
  for (const [key, value] of Object.entries(getAuditHeaders(scope, attempt))) {
    headers.set(key, value);
  }
  return Object.fromEntries(headers.entries());
}
