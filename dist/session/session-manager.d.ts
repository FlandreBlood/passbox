import type { CallerMetadata, ChangedFileEntry, ClaimItem, CoordinatorActionKind, DiffTotals, ExecutionStatus, ExitReasonInfo, ModelSource, NativeHarnessEventClaim, ReasoningEffort, ReportedStatus, RunRecord, TaskContract, TaskRecord, TokenUsageSummary, VerificationStatus, VerifyCommandResult } from '../types.js';
import { ArchiveStore } from '../observability/index.js';
export interface BoardCoordinatorRow {
    agent: string;
    model: string | null;
    session_id: string | null;
    bridge_state: 'collecting' | 'queued_steer' | 'delegated_running' | 'canceled' | 'idle_collected' | 'idle_ready';
    last_action: CoordinatorActionKind;
    last_action_detail: string | null;
    last_action_at: string;
    queued_steers_count: number;
}
export interface BoardExecutorRow {
    run_id: string | null;
    mode: RunRecord['mode'] | null;
    status: ExecutionStatus;
    phase: string;
    thread_id: string | null;
    resolved_model: string | null;
    model_source: ModelSource;
    reasoning_effort: string | null;
    started_at: string | null;
    finished_at: string | null;
    duration_ms: number | null;
    last_event: string | null;
    last_event_at: string | null;
    exit_code: number | null;
    exit_reason: ExitReasonInfo;
}
export interface BoardRevisionDetail {
    run_id: string;
    sequence: number;
    mode: RunRecord['mode'];
    revision: number | null;
    started_at: string;
    finished_at: string | null;
    duration_ms: number | null;
    thread_id: string | null;
    resolved_model: string | null;
    model_source: ModelSource;
    reasoning_effort: string | null;
    execution_status: ExecutionStatus;
    reported_status: ReportedStatus;
    verification_status: VerificationStatus;
    exit_code: number | null;
    exit_reason: ExitReasonInfo;
    instruction_excerpt: string;
    delta_totals: DiffTotals | null;
    ledger_totals: DiffTotals | null;
    delta_files: Array<Pick<ChangedFileEntry, 'path' | 'status' | 'insertions' | 'deletions'>>;
    unexpected_files: string[];
    external_drift_files: string[];
    verify_side_effect_files: string[];
    verify_results: VerifyCommandResult[];
    unverified_blockers: ClaimItem[];
    unverified_counter_evidence: ClaimItem[];
    native_events: NativeHarnessEventClaim[];
    usage: TokenUsageSummary | null;
    error_summary: string | null;
}
export interface BoardTaskItem {
    task_id: string;
    objective: string;
    workspace: string;
    workspace_name: string;
    workspace_mode: 'snapshot' | 'worktree';
    state: 'running' | 'idle';
    current_revision: number;
    created_at: string;
    updated_at: string;
    coordinator: BoardCoordinatorRow;
    executor: BoardExecutorRow;
    ledger_totals: DiffTotals;
    runs: BoardRevisionDetail[];
}
export interface PassboxBoardSnapshot {
    generated_at: string;
    focus_task_id: string | null;
    default_codex_model: {
        resolved_model: string | null;
        model_source: ModelSource;
        reasoning_effort: string | null;
    };
    summary: {
        total_tasks: number;
        running_tasks: number;
        idle_tasks: number;
        failed_or_interrupted_tasks: number;
    };
    tasks: BoardTaskItem[];
}
export declare class SessionManager {
    readonly archive: ArchiveStore;
    constructor(archive: ArchiveStore);
    /**
     * Reconciles a task whose detached worker died unexpectedly without publishing its revision,
     * still collecting deterministic post-crash workspace evidence so nothing is lost.
     */
    getAndReconcileTask(taskId: string): Promise<{
        task: TaskRecord;
        activeRun: RunRecord | null;
    }>;
    private ensureWorkspaceAvailableForWrite;
    delegate(params: {
        objective: string;
        workspace: string;
        contract?: TaskContract;
        model?: string | null;
        reasoningEffort?: ReasoningEffort | string | null;
        caller?: CallerMetadata | null;
        timeoutMs?: number;
    }): Promise<{
        task_id: string;
        run_id: string;
        state: 'running';
        revision: 0;
        workspace_mode: 'snapshot' | 'worktree';
        execution_workspace: string;
        model: string | null;
        model_source: ModelSource;
        reasoning_effort: string | null;
    }>;
    /**
     * Event-driven long wait for `passbox_collect`.
     * Transport cancellation (`signal`) resolves immediately without terminating the task!
     */
    waitForCollect(params: {
        taskId: string;
        sinceRevision?: number;
        waitSeconds?: number;
        signal?: AbortSignal;
    }): Promise<{
        task: TaskRecord;
        activeRun: RunRecord | null;
        waitedMs: number;
    }>;
    steer(params: {
        taskId: string;
        instruction: string;
        resetContext?: boolean;
        model?: string | null;
        reasoningEffort?: ReasoningEffort | string | null;
        caller?: CallerMetadata | null;
        timeoutMs?: number;
    }): Promise<Record<string, unknown>>;
    cancel(taskId: string): Promise<Record<string, unknown>>;
    /**
     * Builds a complete, redacted, backward-compatible multi-agent status board snapshot
     * for the Passbox MCP App (`ui://passbox/board.html`).
     */
    getBoardSnapshot(options?: {
        focusTaskId?: string;
        limit?: number;
    }): Promise<PassboxBoardSnapshot>;
}
