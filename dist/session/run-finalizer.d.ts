import type { ExecutionStatus, ExitReasonInfo, ModelSource, NativeHarnessEventClaim, ProcessIdentityRecord, ReasoningEffort, ReportedStatus, RevisionMetadata, TaskContract, TaskRecord, TokenUsageSummary } from '../types.js';
import { ArchiveStore } from '../observability/index.js';
export interface WorkerRunSpec {
    data_dir: string;
    task_id: string;
    run_id: string;
    execution_workspace: string;
    prompt: string;
    resume_thread_id: string | null;
    model?: string | null;
    reasoning_effort?: ReasoningEffort | null;
    timeout_ms: number;
}
export declare const WORKER_ENTRYPOINT_PATH: string;
export declare function normalizeWorkspaceComparisonKey(workspacePath: string): string;
export declare function readTaskRecordLocked(archive: ArchiveStore, taskId: string): TaskRecord;
export declare function mutateTaskRecord<T>(archive: ArchiveStore, taskId: string, mutator: (task: TaskRecord) => T): T;
/**
 * Spawns the background run worker so it BOTH survives parent MCP exit AND never pops up
 * a blank console window on Windows 11.
 *
 * On Windows, Node.js/libuv maps `detached: true` to `CREATE_NEW_CONSOLE`, triggering Windows
 * Terminal (DefTerm) to pop up an empty window (closing which kills `codex` with `0xC000013A`),
 * whereas `detached: false` attaches the child to libuv's `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`
 * job handle so it dies if the parent exits. Calling Win32 `CreateProcessW` directly with
 * `DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_BREAKAWAY_FROM_JOB | CREATE_NO_WINDOW`
 * (`0x09000208`) breaks away from libuv's job AND suppresses console creation at the kernel level.
 */
export declare function spawnDetachedRunWorker(spec: WorkerRunSpec): {
    pid: number | null;
    identity: ProcessIdentityRecord | null;
};
export interface FinalizeRunEvidenceParams {
    archive: ArchiveStore;
    taskId: string;
    runId: string;
    executionStatus: Exclude<ExecutionStatus, 'running'>;
    reportedStatus: ReportedStatus;
    blockers: RevisionMetadata['unverified_blockers'];
    counterEvidence: RevisionMetadata['unverified_counter_evidence'];
    nativeEvents: NativeHarnessEventClaim[];
    exitCode: number | null;
    exitReason?: ExitReasonInfo;
    durationMs?: number;
    resolvedModel?: string | null;
    modelSource?: ModelSource;
    reasoningEffort?: string | null;
    lastEvent?: string | null;
    usage: TokenUsageSummary | null;
    stderrSummary: string;
    skipVerification?: boolean;
    signal?: AbortSignal;
}
/**
 * Collects post-execution Git snapshot, runs independent `verify_commands` (unless canceled),
 * distinguishes execution diff from verification side-effects and pre-run external drift,
 * publishes an immutable revision in M6, and either dispatches any queued steer or transitions idle.
 */
export declare function finalizeRunAndPublishRevision(params: FinalizeRunEvidenceParams): Promise<{
    publishedRevision: number;
    spawnedQueuedRunSpec: WorkerRunSpec | null;
}>;
export declare function buildFollowUpRunPrompt(params: {
    objective: string;
    contract: TaskContract;
    instruction: string;
    resumeThreadId: string | null;
    changedFilesFromBaseline: string[];
}): string;
