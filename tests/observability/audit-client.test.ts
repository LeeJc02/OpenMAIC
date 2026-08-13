import { afterEach, describe, expect, it } from 'vitest';
import {
  beginAuditRun,
  clearAuditRun,
  getAuditHeaders,
  mergeAuditHeaders,
} from '@/lib/observability/audit-client';
import {
  AUDIT_RUN_HEADER,
  AUDIT_SCENE_ORDER_HEADER,
  AUDIT_SCENE_OUTLINE_HEADER,
  AUDIT_SCENE_STAGE_HEADER,
  AUDIT_SCENE_TOTAL_HEADER,
  isValidAuditRunId,
} from '@/lib/observability/audit-types';

function createStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };
}

describe('audit client propagation', () => {
  const originalStorage = globalThis.sessionStorage;

  afterEach(() => {
    Object.defineProperty(globalThis, 'sessionStorage', {
      configurable: true,
      value: originalStorage,
    });
  });

  it('persists one run id per client scope and merges it into headers', () => {
    Object.defineProperty(globalThis, 'sessionStorage', {
      configurable: true,
      value: createStorage(),
    });

    const runId = beginAuditRun('generation', 'audit_client_test');
    expect(runId).toBe('audit_client_test');
    expect(getAuditHeaders('generation')).toEqual({ [AUDIT_RUN_HEADER]: runId });
    expect(mergeAuditHeaders({ 'x-test': '1' }, 'generation')).toEqual({
      'x-test': '1',
      [AUDIT_RUN_HEADER]: runId,
    });
    expect(isValidAuditRunId(runId)).toBe(true);

    clearAuditRun('generation');
    expect(getAuditHeaders('generation')[AUDIT_RUN_HEADER]).not.toBe(runId);
  });

  it('propagates scene identity and position with generation headers', () => {
    Object.defineProperty(globalThis, 'sessionStorage', {
      configurable: true,
      value: createStorage(),
    });

    const headers = mergeAuditHeaders({ 'x-test': '1' }, 'generation', 2, {
      stageId: 'stage-1',
      outlineId: 'outline-7',
      sceneOrder: 7,
      totalScenes: 10,
    });

    expect(headers).toMatchObject({
      [AUDIT_SCENE_STAGE_HEADER]: 'stage-1',
      [AUDIT_SCENE_OUTLINE_HEADER]: 'outline-7',
      [AUDIT_SCENE_ORDER_HEADER]: '7',
      [AUDIT_SCENE_TOTAL_HEADER]: '10',
    });
  });
});
