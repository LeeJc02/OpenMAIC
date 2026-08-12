import { createLogger } from '@/lib/logger';
import { generateClassroom, type GenerateClassroomInput } from '@/lib/server/classroom-generation';
import {
  markClassroomGenerationJobFailed,
  markClassroomGenerationJobRunning,
  markClassroomGenerationJobSucceeded,
  updateClassroomGenerationJobProgress,
} from '@/lib/server/classroom-job-store';
import { startAuditSpan } from '@/lib/observability/audit';

const log = createLogger('ClassroomJob');
const runningJobs = new Map<string, Promise<void>>();

export function runClassroomGenerationJob(
  jobId: string,
  input: GenerateClassroomInput,
  baseUrl: string,
  auditRunId?: string,
): Promise<void> {
  const existing = runningJobs.get(jobId);
  if (existing) {
    return existing;
  }

  const audit = startAuditSpan({
    name: 'generation.classroom-job',
    node: 'job',
    context: {
      module: 'generation',
      operation: 'generation.classroom-job',
      ...(auditRunId ? { auditRunId } : {}),
    },
    input: { jobId, requirement: input.requirement },
  });
  const jobPromise = audit.run(async () => {
    let jobError: unknown;
    try {
      await markClassroomGenerationJobRunning(jobId);

      const result = await generateClassroom(input, {
        baseUrl,
        onProgress: async (progress) => {
          await updateClassroomGenerationJobProgress(jobId, progress);
        },
      });

      await markClassroomGenerationJobSucceeded(jobId, result);
    } catch (error) {
      jobError = error;
      const message = error instanceof Error ? error.message : String(error);
      log.error(`Classroom generation job ${jobId} failed:`, error);
      try {
        await markClassroomGenerationJobFailed(jobId, message);
      } catch (markFailedError) {
        log.error(`Failed to persist failed status for job ${jobId}:`, markFailedError);
      }
    } finally {
      audit.end({
        status: jobError ? 'error' : 'completed',
        eventType: jobError ? 'job.error' : 'job.completed',
        ...(jobError ? { error: jobError } : {}),
      });
      runningJobs.delete(jobId);
    }
  });

  runningJobs.set(jobId, jobPromise);
  return jobPromise;
}
