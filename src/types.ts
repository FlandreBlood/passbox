export type WorkspaceMode = 'snapshot' | 'worktree';

export type ReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

export type ModelSource =
  | 'explicit'
  | 'stream_event'
  | 'session_rollout'
  | 'codex_config'
  | 'codex_cli_default';

export type ExitReasonCode =
  | 'running'
  | 'normal'
  | 'windows_console_interrupt'
  | 'interrupted'
  | 'canceled'
  | 'timed_out'
  | 'spawn_error'
  | 'turn_failed'
  | 'incomplete_stream'
  | 'worker_crashed'
  | 'non_zero_exit';

export interface ExitReasonInfo {
  code: ExitReasonCode;
  exit_code: number | null;
  signal_hex?: string | null;
  label_zh: string;
  label_en: string;
}

export interface CallerMetadata {
  agent?: string;
  model?: string;
  session_id?: string;
}

export type CoordinatorActionKind =
  | 'delegated'
  | 'collecting'
  | 'collected'
  | 'steered'
  | 'queued_steer'
  | 'canceled';

export interface CoordinatorActivityRecord {
  caller?: CallerMetadata | null;
  last_action: CoordinatorActionKind;
  last_action_at: string;
  last_action_detail?: string | null;
  collecting_since?: string | null;
  collecting_until?: string | null;
  collecting_wait_seconds?: number | null;
}

export interface InvariantSpec {
  claim: string;
  evidence?: string;
}

export interface VerifyCommandSpec {
  argv: string[];
  timeout_seconds?: number;
  cwd_rel?: string;
}

export interface TaskContract {
  workspace_mode?: WorkspaceMode;
  expected_files?: string[];
  invariants?: InvariantSpec[];
  acceptance?: string[];
  verify_commands?: VerifyCommandSpec[];
}

export type ExecutionStatus = 'running' | 'succeeded' | 'failed' | 'canceled' | 'timed_out';
export type ReportedStatus = 'completed' | 'partial' | 'blocked' | 'missing' | 'invalid';
export type VerificationStatus = 'passed' | 'failed' | 'timed_out' | 'error' | 'not_run';
export type TaskLifecycleState = 'running' | 'idle';

export interface ClaimItem {
  claim: string;
  evidence?: string | null;
}

export interface ExecutorFinalReport {
  status: 'completed' | 'partial' | 'blocked';
  blockers: ClaimItem[];
  counter_evidence: ClaimItem[];
}

export type OmitReason = 'binary' | 'lockfile' | 'generated' | 'oversized_file';

export interface ChangedFileEntry {
  path: string;
  old_path?: string;
  status: 'A' | 'M' | 'D' | 'R' | 'C' | 'T' | 'U';
  insertions: number;
  deletions: number;
  binary: boolean;
  omitted_from_preview: boolean;
  omit_reason?: OmitReason;
  recall_id?: string;
}

export interface DiffTotals {
  files_changed: number;
  insertions: number;
  deletions: number;
  net_lines: number;
}

export interface GuardSignals {
  try_catch_added: number;
  nullish_or_type_guards_added: number;
  fallback_defaults_added: number;
  early_guard_returns_added: number;
  note: string;
}

export interface VerifyCommandResult {
  index: number;
  argv: string[];
  exit_code: number | null;
  timed_out: boolean;
  spawn_error?: string;
  duration_ms: number;
  output_excerpt: string;
}

export interface SnapshotCapture {
  tree_oid: string;
  head_oid: string | null;
  captured_at: string;
  dirty_entry_count: number;
  scope_notes: string[];
}

export interface RecallArtifactKindMap {
  diff: string;
  ledger_diff: string;
  logs: string;
  raw_trace: string;
  report?: string;
  exec_diff?: string;
  verify_side_effect_diff?: string;
  range_diff?: string;
}

export interface RecallIndexEntry {
  recall_id: string;
  task_id: string;
  revision: number;
  kind:
    | 'diff'
    | 'ledger_diff'
    | 'file_diff'
    | 'logs'
    | 'raw_trace'
    | 'report'
    | 'diagnostic'
    | 'exec_diff'
    | 'verify_side_effect_diff'
    | 'range_diff';
  file_path_rel: string;
  target_path?: string;
  byte_length: number;
  created_at: string;
}

export interface TokenUsageSummary {
  input_tokens?: number;
  cached_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
}

export interface NativeHarnessEventClaim {
  source: 'native_harness_event';
  message: string;
}

export type RunActivityKind = 'phase' | 'command' | 'tool' | 'file_change' | 'turn' | 'notice';
export type RunActivityStatus = 'started' | 'completed' | 'failed' | 'declined' | 'canceled' | 'info';

export interface RunActivityItem {
  at: string;
  kind: RunActivityKind;
  label: string;
  status: RunActivityStatus;
}

export interface RevisionMetadata {
  task_id: string;
  run_id: string;
  revision: number;
  published_at: string;
  from_tree_oid: string;
  exec_tree_oid: string;
  final_tree_oid: string;
  baseline_tree_oid: string;
  execution_status: Exclude<ExecutionStatus, 'running'>;
  reported_status: ReportedStatus;
  verification_status: VerificationStatus;
  exit_code?: number | null;
  exit_reason?: ExitReasonInfo | null;
  duration_ms?: number | null;
  resolved_model?: string | null;
  model_source?: ModelSource;
  reasoning_effort?: string | null;
  ledger_totals: DiffTotals;
  ledger_files: ChangedFileEntry[];
  delta_totals: DiffTotals;
  delta_files: ChangedFileEntry[];
  exec_delta_totals?: DiffTotals;
  exec_delta_files?: ChangedFileEntry[];
  unexpected_files: string[];
  guard_signals: GuardSignals;
  external_drift_files: string[];
  verify_side_effect_files: string[];
  verify_results: VerifyCommandResult[];
  unverified_blockers: ClaimItem[];
  unverified_counter_evidence: ClaimItem[];
  native_events: NativeHarnessEventClaim[];
  snapshot_notes: string[];
  recall_ids: RecallArtifactKindMap;
  activities?: RunActivityItem[];
  activities_omitted_count?: number;
  usage?: TokenUsageSummary | null;
}

export interface ProcessIdentityRecord {
  pid: number;
  born: string;
}

export interface QueuedSteerRecord {
  instruction: string;
  reset_context: boolean;
  queued_at: string;
  model?: string | null;
  reasoning_effort?: ReasoningEffort | null;
  caller?: CallerMetadata | null;
}

export interface RunRecord {
  run_id: string;
  task_id: string;
  sequence: number;
  mode: 'initial' | 'resume' | 'reset_context';
  instruction: string;
  status: ExecutionStatus;
  phase: string;
  thread_id: string | null;
  resumed_from_thread_id: string | null;
  worker_pid: number | null;
  worker_identity: ProcessIdentityRecord | null;
  target_pid: number | null;
  started_at: string;
  finished_at: string | null;
  cancel_requested_at: string | null;
  pre_run_tree_oid: string;
  published_revision: number | null;
  exit_code: number | null;
  exit_reason?: ExitReasonInfo | null;
  duration_ms?: number | null;
  error_summary: string | null;
  requested_model?: string | null;
  resolved_model?: string | null;
  model_source?: ModelSource;
  reasoning_effort?: string | null;
  last_event?: string | null;
  last_event_at?: string | null;
}

export interface TaskRecord {
  title?: string;
  task_id: string;
  objective: string;
  requested_workspace: string;
  repo_root: string;
  execution_workspace: string;
  workspace_mode: WorkspaceMode;
  contract: TaskContract;
  state: TaskLifecycleState;
  created_at: string;
  updated_at: string;
  baseline_snapshot: SnapshotCapture;
  latest_tree_oid: string;
  current_revision: number;
  active_run_id: string | null;
  active_thread_id: string | null;
  archived_thread_ids: string[];
  queued_steer: QueuedSteerRecord | null;
  queued_steers?: QueuedSteerRecord[];
  caller?: CallerMetadata | null;
  preferred_model?: string | null;
  preferred_reasoning_effort?: ReasoningEffort | null;
  runs: RunRecord[];
}

export interface BudgetOptions {
  status_bytes?: number;
  summary_bytes?: number;
  preview_bytes?: number;
  preview_lines?: number;
  recall_bytes?: number;
  hard_max_bytes?: number;
}
