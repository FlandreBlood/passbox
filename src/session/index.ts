export {
  WORKER_ENTRYPOINT_PATH,
  buildFollowUpRunPrompt,
  finalizeRunAndPublishRevision,
  mutateTaskRecord,
  normalizeWorkspaceComparisonKey,
  readTaskRecordLocked,
  spawnDetachedRunWorker,
  type FinalizeRunEvidenceParams,
  type WorkerRunSpec,
} from './run-finalizer.js';
export {
  SessionManager,
  type BoardCoordinatorRow,
  type BoardExecutorRow,
  type BoardRevisionDetail,
  type BoardTaskItem,
  type PassboxBoardSnapshot,
} from './session-manager.js';
