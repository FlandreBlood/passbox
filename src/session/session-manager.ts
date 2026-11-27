import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { deriveTaskTitle } from './task-title.js';
import { readLiveStream, type LiveStream } from './live-stream.js';
import { redactArgv } from '../observability/redact.js';
import { boundActivitySummary, truncateUtf8ByBytes } from '../firewall/budgets.js';
import { resolveEvidenceFileLink, resolveWorkspaceFileLink, type BoardFileLink } from './board-links.js';
import type {
  CallerMetadata,
  ChangedFileEntry,
  ClaimItem,
  CoordinatorActionKind,
  DiffTotals,
  ExecutionStatus,
  ExitReasonInfo,
  ModelSource,
  NativeHarnessEventClaim,
  ReasoningEffort,
  ReportedStatus,
  RevisionMetadata,
  RunActivityItem,
  RunRecord,
  TaskContract,
  TaskRecord,
  TokenUsageSummary,
  VerificationStatus,
  VerifyCommandResult,
} from '../types.js';
import {
  buildInitialDelegationPrompt,
  captureProcessIdentity,
  classifyExitReason,
  isProcessIdentityAlive,
  readAndParseExecutorReport,
  resolveEffectiveCodexModel,
  sanitizeCallerMetadata,
  terminateProcessTree,
  validateModelIdentifier,
  validateReasoningEffort,
} from '../adapters/index.js';
import {
  captureWorkspaceSnapshot,
  computeTreeDiff,
  prepareManagedWorktree,
  resolveGitWorkspaceRoot,
} from '../evidence/index.js';
import {
  ArchiveStore,
  readJsonWithRetry,
  redactSensitiveText,
  withDirectoryLockAsync,
  writeAtomicJson,
  writeAtomicText,
} from '../observability/index.js';
import {
  buildFollowUpRunPrompt,
  finalizeRunAndPublishRevision,
  mutateTaskRecord,
  normalizeWorkspaceComparisonKey,
  readTaskRecordLocked,
  spawnDetachedRunWorker,
  type WorkerRunSpec,
} from './run-finalizer.js';

export interface BoardCoordinatorRow {
  agent: string;
  model: string | null;
  session_id: string | null;
  bridge_state:
    | 'collecting'
    | 'queued_steer'
    | 'delegated_running'
    | 'canceled'
    | 'idle_collected'
    | 'idle_ready';
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
  delta_files: Array<Pick<ChangedFileEntry, 'path' | 'status' | 'insertions' | 'deletions'> & {
    file_link: BoardFileLink | null;
  }>;
  unexpected_files: string[];
  external_drift_files: string[];
  verify_side_effect_files: string[];
  verify_results: VerifyCommandResult[];
  unverified_blockers: Array<ClaimItem & { evidence_link: BoardFileLink | null }>;
  unverified_counter_evidence: Array<ClaimItem & { evidence_link: BoardFileLink | null }>;
  activities: RunActivityItem[];
  activities_omitted_count: number;
  native_events: NativeHarnessEventClaim[];
  usage: TokenUsageSummary | null;
  error_summary: string | null;
}

export interface BoardTaskDetail {
  task_id: string;
  title: string;
  objective_full: string;
  objective_truncated: boolean;
  contract_summary: TaskContract;
  contract_truncated?: boolean;
  selected_run_id: string | null;
  runs_prompts: Array<Pick<RunRecord, 'run_id' | 'sequence' | 'mode'> & {
    instruction_full: string;
    instruction_truncated: boolean;
  }>;
  runs_prompts_omitted?: number;
  rendered_prompt: string;
  rendered_prompt_truncated: boolean;
  selected_run_live: LiveStream | null;
}

export interface BoardTaskItem {
  title: string;
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
  task_detail?: BoardTaskDetail;
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

function makeTaskId(): string {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:TZ.]/g, '')
    .slice(2, 14);
  return `pb_${stamp}_${randomUUID().replace(/-/g, '').slice(0, 6)}`;
}

function validateTaskContract(raw?: TaskContract): TaskContract {
  if (!raw) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('`contract` must be an object when provided.');
  }
  const mode = raw.workspace_mode ?? 'snapshot';
  if (mode !== 'snapshot' && mode !== 'worktree') {
    throw new Error('`contract.workspace_mode` must be "snapshot" or "worktree".');
  }
  if (raw.expected_files !== undefined) {
    if (
      !Array.isArray(raw.expected_files) ||
      raw.expected_files.some((f) => typeof f !== 'string' || !f.trim())
    ) {
      throw new Error('`contract.expected_files` must be an array of non-empty file path strings.');
    }
  }
  if (raw.invariants !== undefined) {
    if (
      !Array.isArray(raw.invariants) ||
      raw.invariants.some(
        (inv) =>
          !inv ||
          typeof inv !== 'object' ||
          typeof inv.claim !== 'string' ||
          !inv.claim.trim()
      )
    ) {
      throw new Error('`contract.invariants` must be an array of `{ claim, evidence? }` objects.');
    }
  }
  if (raw.acceptance !== undefined) {
    if (
      !Array.isArray(raw.acceptance) ||
      raw.acceptance.some((a) => typeof a !== 'string' || !a.trim())
    ) {
      throw new Error('`contract.acceptance` must be an array of non-empty strings.');
    }
  }
  if (raw.verify_commands !== undefined) {
    if (!Array.isArray(raw.verify_commands)) {
      throw new Error('`contract.verify_commands` must be an array of `{ argv, timeout_seconds? }`.');
    }
    for (let i = 0; i < raw.verify_commands.length; i++) {
      const cmd = raw.verify_commands[i];
      if (
        !cmd ||
        typeof cmd !== 'object' ||
        !Array.isArray(cmd.argv) ||
        cmd.argv.length === 0 ||
        cmd.argv.some((arg) => typeof arg !== 'string') ||
        !cmd.argv[0]?.trim()
      ) {
        throw new Error(
          `contract.verify_commands[${i}].argv must be a non-empty string[] array.`
        );
      }
    }
  }
  return {
    workspace_mode: mode,
    ...(raw.expected_files ? { expected_files: raw.expected_files } : {}),
    ...(raw.invariants ? { invariants: raw.invariants } : {}),
    ...(raw.acceptance ? { acceptance: raw.acceptance } : {}),
    ...(raw.verify_commands ? { verify_commands: raw.verify_commands } : {}),
  };
}

function extractTailTraceEventSummary(rawTraceFile: string): string | null {
  try {
    if (!fs.existsSync(rawTraceFile)) return null;
    const st = fs.statSync(rawTraceFile);
    if (st.size <= 0) return null;
    const readLen = Math.min(st.size, 8192);
    const fd = fs.openSync(rawTraceFile, 'r');
    try {
      const buf = Buffer.alloc(readLen);
      fs.readSync(fd, buf, 0, readLen, st.size - readLen);
      const lines = buf
        .toString('utf8')
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l.startsWith('{'));
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const ev = JSON.parse(lines[i]) as Record<string, unknown>;
          const type = String(ev.type ?? '');
          if (type === 'turn.completed') return 'turn.completed';
          if (type === 'turn.failed') return 'turn.failed';
          if ((type === 'item.started' || type === 'item.completed') && ev.item && typeof ev.item === 'object') {
            const item = ev.item as Record<string, unknown>;
            const it = String(item.type ?? '');
            if (it === 'mcp_tool_call') {
              return `${type === 'item.started' ? 'calling' : 'done'} ${String(item.server ?? 'mcp')}.${String(item.tool ?? 'call')}`;
            }
            if (it === 'command_execution') {
              return `${type === 'item.started' ? 'running cmd' : 'ran cmd'}: ${String(item.command ?? '').replace(/\s+/g, ' ').trim().slice(0, 90)}`;
            }
            if (it === 'file_change') return 'file_change';
            if (it === 'agent_message') return 'agent_message emitted';
          }
        } catch {}
      }
    } finally {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  } catch {}
  return null;
}

export const DEFAULT_COLLECT_WAIT_SECONDS = 600;

export function resolveMaxCollectWaitSeconds(): number {
  const raw = process.env.PASSBOX_MAX_COLLECT_WAIT_SECONDS;
  if (raw !== undefined && raw.trim() !== '') {
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) {
      return Math.max(60, Math.min(Math.floor(parsed), 1800));
    }
  }
  return 1800;
}

export class SessionManager {
  readonly archive: ArchiveStore;
  private readonly lastBornCheckMs = new Map<string, number>();

  constructor(archive: ArchiveStore) {
    this.archive = archive;
  }

  /**
   * Reconciles a task whose detached worker died unexpectedly without publishing its revision,
   * still collecting deterministic post-crash workspace evidence so nothing is lost.
   */
  async getAndReconcileTask(taskId: string): Promise<{
    task: TaskRecord;
    activeRun: RunRecord | null;
  }> {
    if (!/^[A-Za-z0-9_-]{4,80}$/.test(taskId)) {
      throw new Error(`Invalid task_id format: "${taskId}".`);
    }
    let task = readTaskRecordLocked(this.archive, taskId);
    if (task.state !== 'running' || !task.active_run_id) {
      this.lastBornCheckMs.delete(taskId);
      return { task, activeRun: null };
    }

    const activeRun = task.runs.find((r) => r.run_id === task.active_run_id) ?? null;
    if (!activeRun) {
      this.lastBornCheckMs.delete(taskId);
      task = mutateTaskRecord(this.archive, taskId, (t) => {
        t.state = 'idle';
        t.active_run_id = null;
        return t;
      });
      return { task, activeRun: null };
    }

    // Give newly spawned workers a startup window (8000ms) while spawnDetachedRunWorker registers worker_pid
    const ageMs = Date.now() - Date.parse(activeRun.started_at);
    if (activeRun.worker_pid === null && ageMs < 8000) {
      return { task, activeRun };
    }

    const nowMs = Date.now();
    const idleSinceUpdateMs = nowMs - Date.parse(task.updated_at);
    const verifyBorn =
      idleSinceUpdateMs > 10000 && nowMs - (this.lastBornCheckMs.get(taskId) ?? 0) >= 15000;
    if (verifyBorn) {
      this.lastBornCheckMs.set(taskId, nowMs);
    }
    const alive =
      activeRun.worker_identity !== null
        ? isProcessIdentityAlive(activeRun.worker_identity, verifyBorn)
        : activeRun.worker_pid !== null &&
          isProcessIdentityAlive({ pid: activeRun.worker_pid, born: 'unknown' }, false);

    if (alive) {
      return { task, activeRun };
    }

    // Re-read task.json in case the worker published right before exiting
    task = readTaskRecordLocked(this.archive, taskId);
    const refreshedRun = task.runs.find((r) => r.run_id === activeRun.run_id) ?? null;
    if (task.state !== 'running' || !refreshedRun || refreshedRun.published_revision !== null) {
      const nextActive = task.active_run_id
        ? task.runs.find((r) => r.run_id === task.active_run_id) ?? null
        : null;
      return { task, activeRun: nextActive };
    }

    // Worker died without publishing -> recover partial artifacts & workspace snapshot
    const runPaths = this.archive.runPaths(taskId, refreshedRun.run_id);
    const parsedReport = readAndParseExecutorReport(runPaths.lastMessageFile, null);
    let stderrSummary = '';
    if (fs.existsSync(runPaths.stderrFile)) {
      try {
        stderrSummary = fs.readFileSync(runPaths.stderrFile, 'utf8').slice(-600);
      } catch {}
    }
    const wasCanceled = Boolean(
      refreshedRun.cancel_requested_at || fs.existsSync(runPaths.cancelFlagFile)
    );
    const recStatus = wasCanceled ? 'canceled' : 'failed';

    await finalizeRunAndPublishRevision({
      archive: this.archive,
      taskId,
      runId: refreshedRun.run_id,
      executionStatus: recStatus,
      reportedStatus: parsedReport.reportedStatus,
      blockers: parsedReport.report?.blockers ?? [],
      counterEvidence: parsedReport.report?.counter_evidence ?? [],
      nativeEvents: [
        {
          source: 'native_harness_event',
          message: wasCanceled
            ? 'Execution terminated on cancellation.'
            : 'Worker process exited unexpectedly; recovered workspace evidence.',
        },
      ],
      exitCode: null,
      exitReason: classifyExitReason({
        executionStatus: recStatus,
        exitCode: null,
        workerCrashed: !wasCanceled,
      }),
      usage: null,
      stderrSummary,
      skipVerification: wasCanceled,
    });

    const reconciledTask = readTaskRecordLocked(this.archive, taskId);
    const reconciledActive = reconciledTask.active_run_id
      ? reconciledTask.runs.find((r) => r.run_id === reconciledTask.active_run_id) ?? null
      : null;
    return { task: reconciledTask, activeRun: reconciledActive };
  }

  private async ensureWorkspaceAvailableForWrite(
    executionWorkspace: string,
    excludeTaskId?: string
  ): Promise<void> {
    const targetKey = normalizeWorkspaceComparisonKey(executionWorkspace);
    const taskDirs = this.archive.listTaskIds();

    for (const otherId of taskDirs) {
      if (otherId === excludeTaskId) continue;
      const stateFile = this.archive.taskStateFile(otherId);
      if (!fs.existsSync(stateFile)) continue;
      let other: TaskRecord;
      try {
        other = readJsonWithRetry<TaskRecord>(stateFile);
      } catch {
        continue;
      }
      if (other.state !== 'running') continue;
      if (normalizeWorkspaceComparisonKey(other.execution_workspace) !== targetKey) continue;

      const { task: reconciled } = await this.getAndReconcileTask(otherId);
      if (reconciled.state === 'running') {
        throw new Error(
          `Workspace "${executionWorkspace}" already has an active running task ("${otherId}"). ` +
            `Collect, steer, or cancel "${otherId}", or set contract.workspace_mode="worktree".`
        );
      }
    }
  }

  async delegate(params: {
    title?: string;
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
  }> {
    if (!params.objective || typeof params.objective !== 'string' || !params.objective.trim()) {
      throw new Error('`objective` is required and must be a non-empty string.');
    }
    const repoRoot = resolveGitWorkspaceRoot(params.workspace);
    const contract = validateTaskContract(params.contract);
    const requestedModel = validateModelIdentifier(params.model);
    const requestedEffort = validateReasoningEffort(params.reasoningEffort);
    const caller = sanitizeCallerMetadata(params.caller);
    const workspaceMode = contract.workspace_mode ?? 'snapshot';

    const previewModel = resolveEffectiveCodexModel({
      requestedModel,
      requestedEffort,
    });

    const taskId = makeTaskId();
    const runId = 'run_1';
    const prompt = buildInitialDelegationPrompt({
      objective: params.objective,
      contract,
    });

    const { executionWorkspace, spec } = await withDirectoryLockAsync(
      this.archive.globalLockDir(),
      async () => {
        if (workspaceMode === 'snapshot') {
          await this.ensureWorkspaceAvailableForWrite(repoRoot);
        }

        const baselineSnapshot = captureWorkspaceSnapshot(repoRoot);
        const execWs =
          workspaceMode === 'worktree'
            ? prepareManagedWorktree(
                repoRoot,
                taskId,
                this.archive.worktreesRootDir(),
                baselineSnapshot
              )
            : repoRoot;

        const runPaths = this.archive.runPaths(taskId, runId);
        const runSpec: WorkerRunSpec = {
          data_dir: this.archive.dataDir,
          task_id: taskId,
          run_id: runId,
          execution_workspace: execWs,
          prompt,
          resume_thread_id: null,
          model: requestedModel,
          reasoning_effort: requestedEffort,
          timeout_ms: params.timeoutMs ?? 30 * 60 * 1000,
        };
        writeAtomicJson(runPaths.specFile, runSpec);

        const now = new Date().toISOString();
        const initialRun: RunRecord = {
          run_id: runId,
          task_id: taskId,
          sequence: 1,
          mode: 'initial',
          instruction: params.objective.trim(),
          status: 'running',
          phase: 'starting',
          thread_id: null,
          resumed_from_thread_id: null,
          worker_pid: null,
          worker_identity: null,
          target_pid: null,
          started_at: now,
          finished_at: null,
          cancel_requested_at: null,
          pre_run_tree_oid: baselineSnapshot.tree_oid,
          published_revision: null,
          exit_code: null,
          exit_reason: null,
          duration_ms: null,
          error_summary: null,
          requested_model: requestedModel,
          resolved_model: previewModel.resolvedModel,
          model_source: previewModel.modelSource,
          reasoning_effort: previewModel.reasoningEffort,
          last_event: 'launching codex exec',
          last_event_at: now,
        };

        const taskRecord: TaskRecord = {
          task_id: taskId,
          title: deriveTaskTitle(params.objective, params.title),
          objective: params.objective.trim(),
          requested_workspace: params.workspace,
          repo_root: repoRoot,
          execution_workspace: execWs,
          workspace_mode: workspaceMode,
          contract,
          state: 'running',
          created_at: now,
          updated_at: now,
          baseline_snapshot: baselineSnapshot,
          latest_tree_oid: baselineSnapshot.tree_oid,
          current_revision: 0,
          active_run_id: runId,
          active_thread_id: null,
          archived_thread_ids: [],
          queued_steer: null,
          queued_steers: [],
          caller,
          preferred_model: requestedModel,
          preferred_reasoning_effort: requestedEffort,
          runs: [initialRun],
        };

        writeAtomicJson(this.archive.taskStateFile(taskId), taskRecord);
        this.archive.writeCoordinatorActivity(taskId, {
          caller,
          last_action: 'delegated',
          last_action_at: now,
          last_action_detail: `${runId} (initial)`,
        });
        return { executionWorkspace: execWs, spec: runSpec };
      }
    );

    const spawned = spawnDetachedRunWorker(spec);
    mutateTaskRecord(this.archive, taskId, (task) => {
      const r = task.runs.find((x) => x.run_id === runId);
      if (r && r.worker_pid === null) {
        r.worker_pid = spawned.pid;
        r.worker_identity = spawned.identity;
      }
    });

    return {
      task_id: taskId,
      run_id: runId,
      state: 'running',
      revision: 0,
      workspace_mode: workspaceMode,
      execution_workspace: executionWorkspace,
      model: previewModel.resolvedModel,
      model_source: previewModel.modelSource,
      reasoning_effort: previewModel.reasoningEffort,
    };
  }

  /**
   * Event-driven long wait for `passbox_collect`.
   * Transport cancellation (`signal`) resolves immediately without terminating the task!
   */
  async waitForCollect(params: {
    taskId: string;
    sinceRevision?: number;
    waitSeconds?: number;
    signal?: AbortSignal;
    onProgress?: (info: {
      phase: string;
      elapsedSeconds: number;
      totalSeconds: number;
      lastEvent: string | null;
    }) => void;
  }): Promise<{ task: TaskRecord; activeRun: RunRecord | null; waitedMs: number }> {
    const started = Date.now();
    let { task, activeRun } = await this.getAndReconcileTask(params.taskId);

    const waitSec = Math.max(
      0,
      Math.min(params.waitSeconds ?? DEFAULT_COLLECT_WAIT_SECONDS, resolveMaxCollectWaitSeconds())
    );
    const hasUnseenRevision =
      task.current_revision > 0 &&
      (params.sinceRevision === undefined || params.sinceRevision < task.current_revision);

    // Return immediately if task is idle, wait_seconds is 0, or caller already has a newer revision to read
    if (task.state === 'idle' || waitSec === 0 || hasUnseenRevision) {
      if (task.current_revision > 0) {
        this.archive.writeCoordinatorActivity(params.taskId, {
          last_action: 'collected',
          last_action_detail: `rev-${task.current_revision}`,
          collecting_since: null,
          collecting_until: null,
          collecting_wait_seconds: null,
        });
      }
      return { task, activeRun, waitedMs: Date.now() - started };
    }

    const initialRevision = task.current_revision;
    const deadline = started + waitSec * 1000;
    const taskDir = this.archive.taskDir(params.taskId);

    this.archive.writeCoordinatorActivity(params.taskId, {
      last_action: 'collecting',
      last_action_at: new Date(started).toISOString(),
      last_action_detail: `${activeRun?.run_id ?? 'active'} (${waitSec}s)`,
      collecting_since: new Date(started).toISOString(),
      collecting_until: new Date(deadline).toISOString(),
      collecting_wait_seconds: waitSec,
    });

    await new Promise<void>((resolve) => {
      let settled = false;
      let watcher: fs.FSWatcher | null = null;
      let pollTimer: NodeJS.Timeout | null = null;
      let progressTimer: NodeJS.Timeout | null = null;
      let deadlineTimer: NodeJS.Timeout | null = null;
      let checking = false;
      let lastReportedPhase = activeRun?.phase ?? 'running';
      let lastProgressAt = started;

      const emitProgress = () => {
        if (!params.onProgress || settled) return;
        try {
          params.onProgress({
            phase: activeRun?.phase ?? 'running',
            elapsedSeconds: Math.max(0, Math.floor((Date.now() - started) / 1000)),
            totalSeconds: Math.ceil(waitSec),
            lastEvent: activeRun?.last_event ?? null,
          });
        } catch {}
      };

      const finish = () => {
        if (settled) return;
        settled = true;
        if (watcher) {
          try {
            watcher.close();
          } catch {}
        }
        if (pollTimer) clearInterval(pollTimer);
        if (progressTimer) clearInterval(progressTimer);
        if (deadlineTimer) clearTimeout(deadlineTimer);
        params.signal?.removeEventListener('abort', finish);
        resolve();
      };

      const checkProgress = async () => {
        if (settled || checking) return;
        checking = true;
        try {
          const next = await this.getAndReconcileTask(params.taskId);
          task = next.task;
          activeRun = next.activeRun;
          if (task.current_revision > initialRevision || task.state === 'idle') {
            finish();
          } else if (Date.now() >= deadline) {
            finish();
          } else if (params.onProgress) {
            const now = Date.now();
            const currentPhase = activeRun?.phase ?? 'running';
            if (currentPhase !== lastReportedPhase && now - lastProgressAt >= 1000) {
              lastReportedPhase = currentPhase;
              lastProgressAt = now;
              emitProgress();
            }
          }
        } catch {
          finish();
        } finally {
          checking = false;
        }
      };

      try {
        watcher = fs.watch(taskDir, () => {
          void checkProgress();
        });
        watcher.on('error', () => {});
      } catch {}

      pollTimer = setInterval(() => {
        void checkProgress();
      }, 500);

      if (params.onProgress) {
        progressTimer = setInterval(() => {
          const now = Date.now();
          if (now - lastProgressAt >= 5000) {
            lastProgressAt = now;
            lastReportedPhase = activeRun?.phase ?? lastReportedPhase;
            emitProgress();
          }
        }, 15000);
      }

      deadlineTimer = setTimeout(finish, Math.max(10, deadline - Date.now()));
      params.signal?.addEventListener('abort', finish, { once: true });
      if (params.signal?.aborted) finish();
    });

    const latest = await this.getAndReconcileTask(params.taskId);
    this.archive.writeCoordinatorActivity(params.taskId, {
      last_action: latest.task.state === 'idle' ? 'collected' : 'collecting',
      last_action_detail:
        latest.task.state === 'idle'
          ? `rev-${latest.task.current_revision}`
          : `unchanged (rev-${latest.task.current_revision})`,
      collecting_since: null,
      collecting_until: null,
      collecting_wait_seconds: null,
    });
    return {
      task: latest.task,
      activeRun: latest.activeRun,
      waitedMs: Date.now() - started,
    };
  }

  async steer(params: {
    taskId: string;
    instruction: string;
    resetContext?: boolean;
    model?: string | null;
    reasoningEffort?: ReasoningEffort | string | null;
    caller?: CallerMetadata | null;
    timeoutMs?: number;
  }): Promise<Record<string, unknown>> {
    if (
      !params.instruction ||
      typeof params.instruction !== 'string' ||
      !params.instruction.trim()
    ) {
      throw new Error('`instruction` is required and must be a non-empty string.');
    }
    const resetContext = Boolean(params.resetContext);
    const requestedModel = validateModelIdentifier(params.model);
    const requestedEffort = validateReasoningEffort(params.reasoningEffort);
    const caller = sanitizeCallerMetadata(params.caller);
    let { task, activeRun } = await this.getAndReconcileTask(params.taskId);

    // Case 1: Active CLI run and reset_context=false -> atomically push onto FIFO steer queue
    if (task.state === 'running' && activeRun && !resetContext) {
      const queuedResult = mutateTaskRecord(this.archive, params.taskId, (t) => {
        if (t.state === 'running' && t.active_run_id) {
          if (caller) t.caller = { ...(t.caller ?? {}), ...caller };
          const queue = Array.isArray(t.queued_steers)
            ? [...t.queued_steers]
            : t.queued_steer
              ? [t.queued_steer]
              : [];
          queue.push({
            instruction: params.instruction.trim(),
            reset_context: false,
            queued_at: new Date().toISOString(),
            ...(requestedModel ? { model: requestedModel } : {}),
            ...(requestedEffort ? { reasoning_effort: requestedEffort } : {}),
            ...(caller ? { caller } : {}),
          });
          t.queued_steers = queue;
          t.queued_steer = queue[0] ?? null;
          return {
            queued: true,
            activeRunId: t.active_run_id,
            queuePosition: queue.length,
            queuedCount: queue.length,
          };
        }
        return { queued: false, activeRunId: null, queuePosition: 0, queuedCount: 0 };
      });

      if (queuedResult.queued) {
        this.archive.writeCoordinatorActivity(params.taskId, {
          ...(caller ? { caller } : {}),
          last_action: 'queued_steer',
          last_action_detail: `queue #${queuedResult.queuePosition}`,
        });
        return {
          task_id: params.taskId,
          action: 'queued',
          delivery: 'queued_for_next_run',
          realtime_steer: 'unsupported_in_cli_mode',
          active_run_id: queuedResult.activeRunId,
          queue_position: queuedResult.queuePosition,
          queued_count: queuedResult.queuedCount,
        };
      }
      const refreshed = await this.getAndReconcileTask(params.taskId);
      task = refreshed.task;
      activeRun = refreshed.activeRun;
    }

    // Case 2: Active run and reset_context=true -> stop active run and confirm old writer exited cleanly
    let stoppedRunId: string | null = null;
    if (task.state === 'running' && activeRun && resetContext) {
      stoppedRunId = activeRun.run_id;
      await this.cancel(params.taskId);
      const afterCancel = await this.getAndReconcileTask(params.taskId);
      if (afterCancel.task.state !== 'idle' || afterCancel.activeRun !== null) {
        throw new Error(
          `Cannot start reset_context run for "${params.taskId}": previous run "${stoppedRunId}" is still active.`
        );
      }
      task = afterCancel.task;
    }

    let launchedRunId = '';
    let launchedMode: string = 'resume';
    let usedThreadId: string | null = null;
    let specToSpawn: WorkerRunSpec | null = null;
    let effectiveModelInfo: {
      resolvedModel: string | null;
      modelSource: ModelSource;
      reasoningEffort: string | null;
    } | null = null;
    let queuedInRace: { activeRunId: string; queuePosition: number; queuedCount: number } | null =
      null;

    await withDirectoryLockAsync(this.archive.globalLockDir(), async () => {
      if (task.workspace_mode === 'snapshot') {
        await this.ensureWorkspaceAvailableForWrite(task.execution_workspace, params.taskId);
      }

      const preRunSnap = captureWorkspaceSnapshot(task.execution_workspace);
      const ledgerSoFar = computeTreeDiff(
        task.execution_workspace,
        task.baseline_snapshot.tree_oid,
        preRunSnap.tree_oid
      );

      mutateTaskRecord(this.archive, params.taskId, (t) => {
        if (caller) t.caller = { ...(t.caller ?? {}), ...caller };
        if (requestedModel) t.preferred_model = requestedModel;
        if (requestedEffort) t.preferred_reasoning_effort = requestedEffort;

        if (t.state === 'running' && t.active_run_id) {
          if (resetContext) {
            throw new Error(
              `Cannot start reset_context run for "${params.taskId}": active run "${t.active_run_id}" is running.`
            );
          }
          const queue = Array.isArray(t.queued_steers)
            ? [...t.queued_steers]
            : t.queued_steer
              ? [t.queued_steer]
              : [];
          queue.push({
            instruction: params.instruction.trim(),
            reset_context: false,
            queued_at: new Date().toISOString(),
            ...(requestedModel ? { model: requestedModel } : {}),
            ...(requestedEffort ? { reasoning_effort: requestedEffort } : {}),
            ...(caller ? { caller } : {}),
          });
          t.queued_steers = queue;
          t.queued_steer = queue[0] ?? null;
          queuedInRace = {
            activeRunId: t.active_run_id,
            queuePosition: queue.length,
            queuedCount: queue.length,
          };
          return;
        }

        let resumeThreadId: string | null = t.active_thread_id;
        let runMode: RunRecord['mode'] = 'resume';

        if (resetContext) {
          if (t.active_thread_id) {
            t.archived_thread_ids.push(t.active_thread_id);
          }
          t.active_thread_id = null;
          resumeThreadId = null;
          runMode = 'reset_context';
          launchedMode = 'reset_context';
        } else if (!resumeThreadId) {
          runMode = 'reset_context';
          launchedMode = 'fresh_thread_no_prior_session';
        } else {
          launchedMode = 'resume';
        }

        usedThreadId = resumeThreadId;
        const nextSeq = t.runs.length + 1;
        launchedRunId = `run_${nextSeq}`;

        const effectiveReqModel = requestedModel ?? t.preferred_model ?? null;
        const effectiveReqEffort = requestedEffort ?? t.preferred_reasoning_effort ?? null;
        const previewModel = resolveEffectiveCodexModel({
          requestedModel: effectiveReqModel,
          requestedEffort: effectiveReqEffort,
          threadId: resumeThreadId,
        });
        effectiveModelInfo = previewModel;

        const prompt = buildFollowUpRunPrompt({
          objective: t.objective,
          contract: t.contract,
          instruction: params.instruction.trim(),
          resumeThreadId,
          changedFilesFromBaseline: ledgerSoFar.files.map((f) => f.path),
        });

        const runPaths = this.archive.runPaths(params.taskId, launchedRunId);
        const spec: WorkerRunSpec = {
          data_dir: this.archive.dataDir,
          task_id: params.taskId,
          run_id: launchedRunId,
          execution_workspace: t.execution_workspace,
          prompt,
          resume_thread_id: resumeThreadId,
          model: effectiveReqModel,
          reasoning_effort: effectiveReqEffort,
          timeout_ms: params.timeoutMs ?? 30 * 60 * 1000,
        };
        writeAtomicJson(runPaths.specFile, spec);
        specToSpawn = spec;

        const now = new Date().toISOString();
        const newRun: RunRecord = {
          run_id: launchedRunId,
          task_id: params.taskId,
          sequence: nextSeq,
          mode: runMode,
          instruction: params.instruction.trim(),
          status: 'running',
          phase: 'starting',
          thread_id: resumeThreadId,
          resumed_from_thread_id: resumeThreadId,
          worker_pid: null,
          worker_identity: null,
          target_pid: null,
          started_at: now,
          finished_at: null,
          cancel_requested_at: null,
          pre_run_tree_oid: preRunSnap.tree_oid,
          published_revision: null,
          exit_code: null,
          exit_reason: null,
          duration_ms: null,
          error_summary: null,
          requested_model: effectiveReqModel,
          resolved_model: previewModel.resolvedModel,
          model_source: previewModel.modelSource,
          reasoning_effort: previewModel.reasoningEffort,
          last_event: resumeThreadId ? 'resuming codex thread' : 'launching clean codex thread',
          last_event_at: now,
        };

        t.queued_steer = null;
        t.queued_steers = [];
        t.runs.push(newRun);
        t.active_run_id = launchedRunId;
        t.state = 'running';
      });
    });

    if (queuedInRace) {
      const q: { activeRunId: string; queuePosition: number; queuedCount: number } = queuedInRace;
      this.archive.writeCoordinatorActivity(params.taskId, {
        ...(caller ? { caller } : {}),
        last_action: 'queued_steer',
        last_action_detail: `queue #${q.queuePosition}`,
      });
      return {
        task_id: params.taskId,
        action: 'queued',
        delivery: 'queued_for_next_run',
        realtime_steer: 'unsupported_in_cli_mode',
        active_run_id: q.activeRunId,
        queue_position: q.queuePosition,
        queued_count: q.queuedCount,
      };
    }

    if (specToSpawn) {
      const actualSpec: WorkerRunSpec = specToSpawn;
      const spawned = spawnDetachedRunWorker(actualSpec);
      mutateTaskRecord(this.archive, params.taskId, (t) => {
        const r = t.runs.find((x) => x.run_id === actualSpec.run_id);
        if (r && r.worker_pid === null) {
          r.worker_pid = spawned.pid;
          r.worker_identity = spawned.identity;
        }
      });
      this.archive.writeCoordinatorActivity(params.taskId, {
        ...(caller ? { caller } : {}),
        last_action: 'steered',
        last_action_detail: `${launchedRunId} (${launchedMode})`,
      });
    }

    const modInfo = effectiveModelInfo as {
      resolvedModel: string | null;
      modelSource: ModelSource;
      reasoningEffort: string | null;
    } | null;

    return {
      task_id: params.taskId,
      action: 'started',
      delivery: stoppedRunId ? 'executed_after_stopping_prior_run' : 'started_immediately',
      mode: launchedMode,
      run_id: launchedRunId,
      ...(usedThreadId ? { thread_id: usedThreadId } : {}),
      ...(stoppedRunId ? { stopped_prior_run_id: stoppedRunId } : {}),
      ...(modInfo
        ? {
            model: modInfo.resolvedModel,
            model_source: modInfo.modelSource,
            reasoning_effort: modInfo.reasoningEffort,
          }
        : {}),
    };
  }

  async cancel(taskId: string): Promise<Record<string, unknown>> {
    const initial = await this.getAndReconcileTask(taskId);
    if (initial.task.state === 'idle' || !initial.activeRun) {
      mutateTaskRecord(this.archive, taskId, (t) => {
        t.queued_steer = null;
        t.queued_steers = [];
      });
      return {
        task_id: taskId,
        canceled: false,
        already_idle: true,
        confirmed_exited: true,
        state: 'idle',
        revision: initial.task.current_revision,
      };
    }

    const runToCancel = initial.activeRun;
    const runPaths = this.archive.runPaths(taskId, runToCancel.run_id);
    writeAtomicText(runPaths.cancelFlagFile, `${new Date().toISOString()}\n`);
    this.archive.writeCoordinatorActivity(taskId, {
      last_action: 'canceled',
      last_action_detail: runToCancel.run_id,
      collecting_since: null,
      collecting_until: null,
      collecting_wait_seconds: null,
    });

    mutateTaskRecord(this.archive, taskId, (t) => {
      t.queued_steer = null;
      t.queued_steers = [];
      const r = t.runs.find((x) => x.run_id === runToCancel.run_id);
      if (r && !r.cancel_requested_at) {
        r.cancel_requested_at = new Date().toISOString();
      }
    });

    const killedTargetPids = new Set<number>();
    if (runToCancel.target_pid) {
      killedTargetPids.add(runToCancel.target_pid);
      await terminateProcessTree(runToCancel.target_pid);
    }

    const buildCancelResult = (finalTask: TaskRecord) => {
      const targetRun = finalTask.runs.find((r) => r.run_id === runToCancel.run_id);
      const wasCanceled = targetRun?.status === 'canceled';
      return {
        task_id: taskId,
        canceled: wasCanceled,
        ...(wasCanceled
          ? {}
          : {
              completed_before_cancel: true,
              execution_status: targetRun?.status ?? 'unknown',
            }),
        confirmed_exited: finalTask.state === 'idle',
        canceled_run_id: runToCancel.run_id,
        state: finalTask.state,
        revision: finalTask.current_revision,
      };
    };

    // Wait up to 10s for run-worker to capture evidence and publish the canceled revision cleanly
    const waitDeadline = Date.now() + 10000;
    while (Date.now() < waitDeadline) {
      const check = await this.getAndReconcileTask(taskId);
      if (check.task.state === 'idle' || check.activeRun?.run_id !== runToCancel.run_id) {
        return buildCancelResult(check.task);
      }
      if (check.activeRun?.target_pid && !killedTargetPids.has(check.activeRun.target_pid)) {
        killedTargetPids.add(check.activeRun.target_pid);
        await terminateProcessTree(check.activeRun.target_pid);
      }
      await new Promise((r) => setTimeout(r, 120));
    }

    // Hard kill worker if still stuck past grace period, then reconcile evidence synchronously
    const latestBeforeKill = readTaskRecordLocked(this.archive, taskId);
    const stuckRun = latestBeforeKill.runs.find((r) => r.run_id === runToCancel.run_id);
    if (stuckRun?.target_pid) {
      await terminateProcessTree(stuckRun.target_pid);
    }
    if (stuckRun?.worker_pid) {
      await terminateProcessTree(stuckRun.worker_pid);
    }

    const finalCheck = await this.getAndReconcileTask(taskId);
    return buildCancelResult(finalCheck.task);
  }

  /**
   * Builds a complete, redacted, backward-compatible multi-agent status board snapshot
   * for the Passbox MCP App (`ui://passbox/board.html`).
   */
  async getBoardSnapshot(options?: {
    focusTaskId?: string;
    includeDetail?: boolean;
    runId?: string;
    limit?: number;
  }): Promise<PassboxBoardSnapshot> {
    const maxTasks = Math.max(1, Math.min(options?.limit ?? 20, 50));
    const allIds = this.archive.listTaskIds();
    const loaded: Array<{ task: TaskRecord; activeRun: RunRecord | null }> = [];

    for (const id of allIds) {
      try {
        const raw = readTaskRecordLocked(this.archive, id);
        if (raw.state === 'running') {
          const reconciled = await this.getAndReconcileTask(id);
          loaded.push(reconciled);
        } else {
          loaded.push({ task: raw, activeRun: null });
        }
      } catch {}
    }

    loaded.sort((a, b) => Date.parse(b.task.updated_at) - Date.parse(a.task.updated_at));

    let runningCount = 0;
    let idleCount = 0;
    let failedOrInterruptedCount = 0;
    for (const item of loaded) {
      if (item.task.state === 'running') {
        runningCount++;
      } else {
        idleCount++;
        const lastRun = item.task.runs.at(-1);
        if (
          lastRun &&
          (lastRun.status === 'failed' ||
            lastRun.status === 'timed_out' ||
            lastRun.status === 'canceled')
        ) {
          failedOrInterruptedCount++;
        }
      }
    }

    const selected = loaded.slice(0, maxTasks);
    if (
      options?.focusTaskId &&
      !selected.some((x) => x.task.task_id === options.focusTaskId)
    ) {
      const match = loaded.find((x) => x.task.task_id === options.focusTaskId);
      if (match) {
        selected.unshift(match);
        if (selected.length > maxTasks) selected.pop();
      }
    }

    const defaultCodex = resolveEffectiveCodexModel({});

    let detail: BoardTaskDetail | undefined;
    const detailTaskId = options?.includeDetail ? options.focusTaskId ?? selected[0]?.task.task_id : null;
    const boardTasks: BoardTaskItem[] = selected.map(({ task, activeRun }) => {
      const coordFile = this.archive.readCoordinatorActivity(task.task_id);
      const caller = coordFile?.caller ?? task.caller ?? null;
      const queuedCount = Array.isArray(task.queued_steers)
        ? task.queued_steers.length
        : task.queued_steer
          ? 1
          : 0;

      const isCollectingNow = Boolean(
        task.state === 'running' &&
          coordFile?.collecting_until &&
          Date.parse(coordFile.collecting_until) > Date.now()
      );

      const latestRun = activeRun ?? task.runs.at(-1) ?? null;

      let bridgeState: BoardCoordinatorRow['bridge_state'] = 'idle_ready';
      if (task.state === 'running') {
        if (queuedCount > 0) bridgeState = 'queued_steer';
        else if (isCollectingNow) bridgeState = 'collecting';
        else bridgeState = 'delegated_running';
      } else if (latestRun?.status === 'canceled') {
        bridgeState = 'canceled';
      } else if (coordFile?.last_action === 'collected') {
        bridgeState = 'idle_collected';
      }

      const fallbackAction: CoordinatorActionKind =
        task.state === 'running'
          ? 'delegated'
          : latestRun?.status === 'canceled'
            ? 'canceled'
            : task.runs.length > 1
              ? 'steered'
              : 'delegated';

      const coordinatorRow: BoardCoordinatorRow = {
        agent: caller?.agent || 'Antigravity',
        model: caller?.model || null,
        session_id: caller?.session_id || null,
        bridge_state: bridgeState,
        last_action: coordFile?.last_action ?? fallbackAction,
        last_action_detail:
          coordFile?.last_action_detail ??
          (task.current_revision > 0
            ? `rev-${task.current_revision}`
            : (latestRun?.run_id ?? null)),
        last_action_at: coordFile?.last_action_at ?? task.updated_at,
        queued_steers_count: queuedCount,
      };

      const revMetaByRev = new Map<number, RevisionMetadata>();
      for (let r = 1; r <= task.current_revision; r++) {
        try {
          revMetaByRev.set(r, this.archive.readRevisionMetadata(task.task_id, r));
        } catch {}
      }

      const resolveRunModel = (run: RunRecord | null, meta?: RevisionMetadata) => {
        if (!run) {
          return {
            resolvedModel: defaultCodex.resolvedModel,
            modelSource: defaultCodex.modelSource,
            reasoningEffort: defaultCodex.reasoningEffort,
          };
        }
        if (run.resolved_model || (run.model_source && run.model_source !== 'codex_cli_default')) {
          return {
            resolvedModel: run.resolved_model ?? meta?.resolved_model ?? null,
            modelSource: run.model_source ?? meta?.model_source ?? 'codex_cli_default',
            reasoningEffort: run.reasoning_effort ?? meta?.reasoning_effort ?? null,
          };
        }
        return resolveEffectiveCodexModel({
          requestedModel: run.requested_model,
          requestedEffort: run.reasoning_effort,
          threadId: run.thread_id,
        });
      };

      const resolveRunDuration = (run: RunRecord | null, meta?: RevisionMetadata): number | null => {
        if (!run) return null;
        if (typeof run.duration_ms === 'number') return run.duration_ms;
        if (typeof meta?.duration_ms === 'number') return meta.duration_ms;
        if (run.finished_at) {
          return Math.max(0, Date.parse(run.finished_at) - Date.parse(run.started_at));
        }
        if (run.status === 'running') {
          return Math.max(0, Date.now() - Date.parse(run.started_at));
        }
        return null;
      };

      const resolveRunLastEvent = (run: RunRecord | null): string | null => {
        if (!run) return null;
        if (run.last_event) return redactSensitiveText(run.last_event).slice(0, 160);
        const rp = this.archive.runPaths(task.task_id, run.run_id);
        const tailEv = extractTailTraceEventSummary(rp.rawTraceFile);
        return tailEv ? redactSensitiveText(tailEv).slice(0, 160) : null;
      };

      const latestMeta =
        latestRun?.published_revision != null
          ? revMetaByRev.get(latestRun.published_revision)
          : revMetaByRev.get(task.current_revision);

      const execModel = resolveRunModel(latestRun, latestMeta);
      const execExitReason =
        latestRun?.exit_reason ??
        latestMeta?.exit_reason ??
        classifyExitReason({
          executionStatus: latestRun?.status ?? 'succeeded',
          exitCode: latestRun?.exit_code ?? null,
        });

      const executorRow: BoardExecutorRow = {
        run_id: latestRun?.run_id ?? null,
        mode: latestRun?.mode ?? null,
        status: latestRun?.status ?? 'succeeded',
        phase: latestRun?.phase ?? (task.state === 'idle' ? 'completed' : 'starting'),
        thread_id: latestRun?.thread_id ?? task.active_thread_id ?? null,
        resolved_model: execModel.resolvedModel,
        model_source: execModel.modelSource,
        reasoning_effort: execModel.reasoningEffort,
        started_at: latestRun?.started_at ?? null,
        finished_at: latestRun?.finished_at ?? null,
        duration_ms: resolveRunDuration(latestRun, latestMeta),
        last_event: resolveRunLastEvent(latestRun),
        last_event_at: latestRun?.last_event_at ?? latestRun?.finished_at ?? task.updated_at,
        exit_code: latestRun?.exit_code ?? latestMeta?.exit_code ?? null,
        exit_reason: execExitReason,
      };

      const boardClaim = (item: ClaimItem) => {
        const evidence = item.evidence ? redactSensitiveText(item.evidence) : null;
        return {
          claim: redactSensitiveText(item.claim).slice(0, 600),
          evidence: evidence?.slice(0, 260) ?? null,
          evidence_link: resolveEvidenceFileLink(task.execution_workspace, evidence),
        };
      };

      const title = deriveTaskTitle(task.objective, task.title);
      const visibleRuns = task.runs.slice(-12);
      if (task.task_id === detailTaskId) {
        const run = options?.runId ? task.runs.find(r => r.run_id === options.runId) : latestRun;
        if (!run && options?.runId) throw new Error('Unknown run for this task.');
        if (run && !visibleRuns.includes(run)) visibleRuns.unshift(run);
        const paths = run && this.archive.runPaths(task.task_id, run.run_id);
        const prompt = paths && fs.existsSync(paths.specFile)
          ? readJsonWithRetry<WorkerRunSpec>(paths.specFile).prompt : '';
        const rendered = truncateUtf8ByBytes(redactSensitiveText(prompt), 24 * 1024);
        const objective = truncateUtf8ByBytes(redactSensitiveText(task.objective), 32 * 1024);
        const contract = task.contract;
        detail = {
          task_id: task.task_id, title,
          objective_full: objective.text, objective_truncated: objective.truncated,
          contract_summary: {
            workspace_mode: task.workspace_mode,
            expected_files: contract.expected_files?.map(redactSensitiveText),
            acceptance: contract.acceptance?.map(redactSensitiveText),
            invariants: contract.invariants?.map(i => ({
              claim: redactSensitiveText(i.claim), evidence: i.evidence && redactSensitiveText(i.evidence),
            })),
            verify_commands: contract.verify_commands?.map(c => ({
              argv: redactArgv(c.argv), timeout_seconds: c.timeout_seconds,
              cwd_rel: c.cwd_rel && redactSensitiveText(c.cwd_rel),
            })),
          },
          selected_run_id: run?.run_id ?? null,
          rendered_prompt: rendered.text, rendered_prompt_truncated: rendered.truncated,
          runs_prompts: task.runs.map(({ run_id, sequence, mode, instruction }) => {
            const bounded = truncateUtf8ByBytes(redactSensitiveText(instruction), 16 * 1024);
            return { run_id, sequence, mode, instruction_full: bounded.text, instruction_truncated: bounded.truncated };
          }),
          selected_run_live: run ? readLiveStream(this.archive, task.task_id, task.execution_workspace,
            run, revMetaByRev.get(run.published_revision ?? 0)) : null,
        };
      }
      const runDetails: BoardRevisionDetail[] = visibleRuns.map((run) => {
        const meta =
          run.published_revision != null ? revMetaByRev.get(run.published_revision) : undefined;
        const activitySummary = run.status === 'running'
          ? boundActivitySummary(this.archive.readRunActivities(task.task_id, run.run_id))
          : boundActivitySummary(meta?.activities, meta?.activities_omitted_count);
        const rModel = resolveRunModel(run, meta);
        const rExit =
          run.exit_reason ??
          meta?.exit_reason ??
          classifyExitReason({
            executionStatus: run.status,
            exitCode: run.exit_code,
          });
        return {
          run_id: run.run_id,
          sequence: run.sequence,
          mode: run.mode,
          revision: run.published_revision,
          started_at: run.started_at,
          finished_at: run.finished_at,
          duration_ms: resolveRunDuration(run, meta),
          thread_id: run.thread_id,
          resolved_model: rModel.resolvedModel,
          model_source: rModel.modelSource,
          reasoning_effort: rModel.reasoningEffort,
          execution_status: run.status,
          reported_status: meta?.reported_status ?? (run.status === 'running' ? 'missing' : 'missing'),
          verification_status: meta?.verification_status ?? 'not_run',
          exit_code: run.exit_code ?? meta?.exit_code ?? null,
          exit_reason: rExit,
          instruction_excerpt: redactSensitiveText(run.instruction).slice(0, 280),
          delta_totals: meta?.delta_totals ?? null,
          ledger_totals: meta?.ledger_totals ?? null,
          delta_files: (meta?.delta_files ?? []).slice(0, 15).map((f) => ({
            path: redactSensitiveText(f.path),
            status: f.status,
            insertions: f.insertions,
            deletions: f.deletions,
            file_link: f.status === 'D' ? null : resolveWorkspaceFileLink(task.execution_workspace, f.path),
          })),
          unexpected_files: (meta?.unexpected_files ?? []).slice(0, 10).map(redactSensitiveText),
          external_drift_files: (meta?.external_drift_files ?? []).slice(0, 10).map(redactSensitiveText),
          verify_side_effect_files: (meta?.verify_side_effect_files ?? []).slice(0, 10).map(redactSensitiveText),
          verify_results: (meta?.verify_results ?? []).slice(0, 5).map((v) => ({
            ...v,
            argv: redactArgv(v.argv),
            spawn_error: v.spawn_error && redactSensitiveText(v.spawn_error),
            output_excerpt: redactSensitiveText(v.output_excerpt).slice(0, 320),
          })),
          unverified_blockers: (meta?.unverified_blockers ?? []).slice(0, 20).map(boardClaim),
          unverified_counter_evidence: (meta?.unverified_counter_evidence ?? []).slice(0, 20).map(boardClaim),
          activities: activitySummary.activities,
          activities_omitted_count: activitySummary.omitted_count,
          native_events: (meta?.native_events ?? []).slice(0, 6).map((e) => ({
            source: e.source,
            message: redactSensitiveText(e.message).slice(0, 280),
          })),
          usage: meta?.usage ?? null,
          error_summary: run.error_summary ? redactSensitiveText(run.error_summary).slice(0, 320) : null,
        };
      });

      const latestPublishedMeta = revMetaByRev.get(task.current_revision);
      const ledgerTotals = latestPublishedMeta?.ledger_totals ?? {
        files_changed: 0,
        insertions: 0,
        deletions: 0,
        net_lines: 0,
      };

      return {
        task_id: task.task_id,
        title,
        objective: redactSensitiveText(task.objective).slice(0, 500),
        workspace: redactSensitiveText(task.execution_workspace),
        workspace_name: redactSensitiveText(path.basename(task.repo_root || task.execution_workspace) || task.execution_workspace),
        workspace_mode: task.workspace_mode,
        state: task.state,
        current_revision: task.current_revision,
        created_at: task.created_at,
        updated_at: task.updated_at,
        coordinator: coordinatorRow,
        executor: executorRow,
        ledger_totals: ledgerTotals,
        runs: runDetails,
      };
    });

    return {
      generated_at: new Date().toISOString(),
      focus_task_id: options?.focusTaskId ?? null,
      default_codex_model: {
        resolved_model: defaultCodex.resolvedModel,
        model_source: defaultCodex.modelSource,
        reasoning_effort: defaultCodex.reasoningEffort,
      },
      summary: {
        total_tasks: loaded.length,
        running_tasks: runningCount,
        idle_tasks: idleCount,
        failed_or_interrupted_tasks: failedOrInterruptedCount,
      },
      tasks: boardTasks,
      ...(detail && { task_detail: detail }),
    };
  }
}
