import { WORKMESH_NAME } from "@workmesh/shared";

export const WORKMESH_PHASE = 5 as const;

export function getRuntimeIdentity(): { name: string; phase: number } {
  return { name: WORKMESH_NAME, phase: WORKMESH_PHASE };
}

export { createApp } from "./app.js";
export { migrate } from "./db/migrate.js";
export { createPool, type Db } from "./db/pool.js";
export { JobRepository, type Job } from "./jobs/repository.js";
export { createJobSchema, listJobsQuerySchema } from "./jobs/schema.js";
export { JobLifecycle, DEFAULT_LIFECYCLE_CONFIG, type LifecycleConfig } from "./jobs/lifecycle.js";
export { LeaseReaper } from "./jobs/reaper.js";
export { Scheduler, type ScheduledRun } from "./schedules/scheduler.js";
export { ScheduleRepository } from "./schedules/repository.js";
export {
  describeScheduleProblem,
  latestOccurrenceAtOrBefore,
  nextOccurrenceAfter,
} from "./schedules/cron.js";
export { WorkflowRepository } from "./workflows/repository.js";
export { reconcileWorkflow } from "./workflows/reconcile.js";
export { withTransaction } from "./db/tx.js";
