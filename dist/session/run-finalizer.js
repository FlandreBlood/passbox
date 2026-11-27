import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { captureWorkspaceSnapshot, computeTreeDiff, computeUnexpectedFiles, runVerificationCommands, } from '../evidence/index.js';
import { buildInitialDelegationPrompt, buildResumeSteerPrompt, captureProcessIdentity, classifyExitReason, resolveEffectiveCodexModel, } from '../adapters/index.js';
import { readJsonWithRetry, withDirectoryLock, writeAtomicJson, } from '../observability/index.js';
import { boundActivitySummary } from '../firewall/budgets.js';
const SELF_DIR = path.dirname(fileURLToPath(import.meta.url));
export const WORKER_ENTRYPOINT_PATH = path.join(SELF_DIR, 'run-worker.js');
export function normalizeWorkspaceComparisonKey(workspacePath) {
    const resolved = path.resolve(workspacePath);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}
export function readTaskRecordLocked(archive, taskId) {
    const stateFile = archive.taskStateFile(taskId);
    if (!fs.existsSync(stateFile)) {
        throw new Error(`Unknown task_id: "${taskId}".`);
    }
    return readJsonWithRetry(stateFile);
}
export function mutateTaskRecord(archive, taskId, mutator) {
    return withDirectoryLock(archive.taskLockDir(taskId), () => {
        const task = readTaskRecordLocked(archive, taskId);
        const out = mutator(task);
        task.updated_at = new Date().toISOString();
        writeAtomicJson(archive.taskStateFile(taskId), task);
        return out;
    });
}
function quoteWinCreateProcessArg(value) {
    if (!value)
        return '""';
    if (!/[\s"]/g.test(value))
        return value;
    return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;
}
const WIN32_HEADLESS_SPAWN_PS = `
$app = $env:PASSBOX_WIN_SPAWN_APP
$cmdLine = $env:PASSBOX_WIN_SPAWN_CMDLINE
$cwd = $env:PASSBOX_WIN_SPAWN_CWD
Remove-Item Env:PASSBOX_WIN_SPAWN_APP -ErrorAction SilentlyContinue
Remove-Item Env:PASSBOX_WIN_SPAWN_CMDLINE -ErrorAction SilentlyContinue
Remove-Item Env:PASSBOX_WIN_SPAWN_CWD -ErrorAction SilentlyContinue
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class PassboxWinHeadlessSpawner {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct STARTUPINFO {
    public int cb;
    public string lpReserved;
    public string lpDesktop;
    public string lpTitle;
    public int dwX; public int dwY; public int dwXSize; public int dwYSize;
    public int dwXCountChars; public int dwYCountChars; public int dwFillAttribute;
    public int dwFlags;
    public short wShowWindow;
    public short cbReserved2;
    public IntPtr lpReserved2;
    public IntPtr hStdInput; public IntPtr hStdOutput; public IntPtr hStdError;
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct PROCESS_INFORMATION {
    public IntPtr hProcess; public IntPtr hThread;
    public int dwProcessId; public int dwThreadId;
  }
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool CreateProcessW(
    string app, string cmd, IntPtr pa, IntPtr ta, bool inherit,
    uint flags, IntPtr env, string cwd, ref STARTUPINFO si, out PROCESS_INFORMATION pi);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);

  public static int Launch(string app, string cmdLine, string cwd) {
    STARTUPINFO si = new STARTUPINFO();
    si.cb = Marshal.SizeOf(si);
    PROCESS_INFORMATION pi;
    // DETACHED_PROCESS (0x8) | CREATE_NEW_PROCESS_GROUP (0x200) | CREATE_BREAKAWAY_FROM_JOB (0x01000000) | CREATE_NO_WINDOW (0x08000000)
    uint flagsBreakaway = 0x09000208;
    uint flagsFallback = 0x08000208;
    bool ok = CreateProcessW(app, cmdLine, IntPtr.Zero, IntPtr.Zero, false, flagsBreakaway, IntPtr.Zero, cwd, ref si, out pi);
    if (!ok) {
      ok = CreateProcessW(app, cmdLine, IntPtr.Zero, IntPtr.Zero, false, flagsFallback, IntPtr.Zero, cwd, ref si, out pi);
    }
    if (!ok) {
      throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    }
    CloseHandle(pi.hThread);
    CloseHandle(pi.hProcess);
    return pi.dwProcessId;
  }
}
'@
$pidOut = [PassboxWinHeadlessSpawner]::Launch($app, $cmdLine, $cwd)
$born = 'unknown'
try {
  $proc = Get-Process -Id $pidOut -ErrorAction SilentlyContinue
  if ($proc -and $proc.StartTime) { $born = $proc.StartTime.ToUniversalTime().ToString('o') }
} catch {}
Write-Output "$pidOut|$born"
`;
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
export function spawnDetachedRunWorker(spec) {
    const workerArgs = [WORKER_ENTRYPOINT_PATH, spec.data_dir, spec.task_id, spec.run_id];
    if (process.platform === 'win32') {
        const cmdLine = [process.execPath, ...workerArgs].map(quoteWinCreateProcessArg).join(' ');
        try {
            const res = spawnSync('powershell', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', WIN32_HEADLESS_SPAWN_PS], {
                cwd: spec.execution_workspace,
                env: {
                    ...process.env,
                    PASSBOX_WIN_SPAWN_APP: process.execPath,
                    PASSBOX_WIN_SPAWN_CMDLINE: cmdLine,
                    PASSBOX_WIN_SPAWN_CWD: spec.execution_workspace,
                },
                encoding: 'utf8',
                timeout: 8000,
                windowsHide: true,
            });
            if (res.status === 0 && res.stdout) {
                const line = res.stdout.trim().split(/\r?\n/).pop()?.trim() ?? '';
                const [pidStr, bornStr] = line.split('|');
                const pid = Number(pidStr);
                if (Number.isInteger(pid) && pid > 1) {
                    return {
                        pid,
                        identity: { pid, born: bornStr?.trim() || 'unknown' },
                    };
                }
            }
        }
        catch { }
    }
    const child = spawn(process.execPath, workerArgs, {
        cwd: spec.execution_workspace,
        env: process.env,
        detached: true,
        windowsHide: true,
        stdio: 'ignore',
    });
    child.unref();
    const pid = child.pid ?? null;
    const identity = process.platform === 'win32'
        ? pid
            ? { pid, born: 'unknown' }
            : null
        : captureProcessIdentity(pid);
    return { pid, identity };
}
/**
 * Collects post-execution Git snapshot, runs independent `verify_commands` (unless canceled),
 * distinguishes execution diff from verification side-effects and pre-run external drift,
 * publishes an immutable revision in M6, and either dispatches any queued steer or transitions idle.
 */
export async function finalizeRunAndPublishRevision(params) {
    const { archive, taskId, runId } = params;
    const taskSnapshot = readTaskRecordLocked(archive, taskId);
    const runSnapshot = taskSnapshot.runs.find((r) => r.run_id === runId);
    if (!runSnapshot) {
        throw new Error(`Run "${runId}" missing on task "${taskId}".`);
    }
    if (runSnapshot.published_revision !== null) {
        return { publishedRevision: runSnapshot.published_revision, spawnedQueuedRunSpec: null };
    }
    const runPaths = archive.runPaths(taskId, runId);
    const workspace = taskSnapshot.execution_workspace;
    const effectiveNativeEvents = [...params.nativeEvents];
    const isCancelRequested = () => Boolean(params.signal?.aborted || fs.existsSync(runPaths.cancelFlagFile));
    let effectiveExecutionStatus = isCancelRequested() ? 'canceled' : params.executionStatus;
    // 1. Capture post-Codex execution snapshot
    const execSnap = captureWorkspaceSnapshot(workspace);
    // 2. Run independent verify_commands if configured, enabled, and not canceled
    const hasVerifyCommands = Boolean(taskSnapshot.contract.verify_commands?.length);
    const verifyDisabled = process.env.PASSBOX_DISABLE_VERIFY_COMMANDS === '1' ||
        process.env.PASSBOX_DISABLE_VERIFY_COMMANDS?.toLowerCase() === 'true';
    if (verifyDisabled &&
        hasVerifyCommands &&
        !params.skipVerification &&
        effectiveExecutionStatus !== 'canceled') {
        effectiveNativeEvents.push({
            source: 'native_harness_event',
            message: 'verify_commands disabled by PASSBOX_DISABLE_VERIFY_COMMANDS.',
        });
    }
    const shouldVerify = !params.skipVerification &&
        !verifyDisabled &&
        effectiveExecutionStatus !== 'canceled' &&
        !isCancelRequested() &&
        hasVerifyCommands;
    let verifyOutcome = { status: 'not_run', results: [], combinedLog: '', aborted: false, truncated: false };
    const recordActivity = (kind, label, status) => archive.appendRunActivity(taskId, runId, { at: new Date().toISOString(), kind, label, status });
    if (shouldVerify) {
        recordActivity('phase', 'verifying', 'started');
        mutateTaskRecord(archive, taskId, (t) => {
            const r = t.runs.find((x) => x.run_id === runId);
            if (r && r.status === 'running') {
                r.phase = 'verifying';
                r.target_pid = null;
                r.last_event = 'running independent verify_commands';
                r.last_event_at = new Date().toISOString();
            }
        });
        verifyOutcome = await runVerificationCommands(workspace, taskSnapshot.contract.verify_commands, {
            signal: params.signal,
            logFilePath: runPaths.verifyLogFile,
            onCommandEvent(argv, index, status) {
                const [executable, ...args] = argv;
                const displayArgv = [path.isAbsolute(executable) ? path.basename(executable) : executable, ...args];
                const label = displayArgv.map((arg) => /\s/.test(arg) ? JSON.stringify(arg) : arg).join(' ');
                recordActivity('command', 'verify[' + index + ']: ' + label, status);
            },
            onChildSpawned(pid) {
                mutateTaskRecord(archive, taskId, (t) => {
                    const r = t.runs.find((x) => x.run_id === runId);
                    if (r)
                        r.target_pid = pid;
                });
            },
        });
        mutateTaskRecord(archive, taskId, (t) => {
            const r = t.runs.find((x) => x.run_id === runId);
            if (r)
                r.target_pid = null;
        });
        if (verifyOutcome.aborted || isCancelRequested()) {
            effectiveExecutionStatus = 'canceled';
            verifyOutcome.status = 'not_run';
            effectiveNativeEvents.push({
                source: 'native_harness_event',
                message: 'Verification canceled before completion.',
            });
        }
    }
    // 3. Capture post-verify snapshot if verification ran so test side-effects are isolated
    const finalSnap = shouldVerify ? captureWorkspaceSnapshot(workspace) : execSnap;
    // 4. Compute deterministic diffs
    const ledgerDiff = computeTreeDiff(workspace, taskSnapshot.baseline_snapshot.tree_oid, finalSnap.tree_oid);
    const deltaDiff = computeTreeDiff(workspace, taskSnapshot.latest_tree_oid, finalSnap.tree_oid);
    const execDeltaDiff = execSnap.tree_oid !== finalSnap.tree_oid
        ? computeTreeDiff(workspace, taskSnapshot.latest_tree_oid, execSnap.tree_oid)
        : null;
    const driftDiff = taskSnapshot.latest_tree_oid !== runSnapshot.pre_run_tree_oid
        ? computeTreeDiff(workspace, taskSnapshot.latest_tree_oid, runSnapshot.pre_run_tree_oid)
        : null;
    const verifySideDiff = execSnap.tree_oid !== finalSnap.tree_oid
        ? computeTreeDiff(workspace, execSnap.tree_oid, finalSnap.tree_oid)
        : null;
    const unexpectedFiles = computeUnexpectedFiles(ledgerDiff.files.map((f) => f.path), taskSnapshot.contract.expected_files);
    const combinedLogs = [
        params.stderrSummary ? `=== codex stderr excerpt ===\n${params.stderrSummary}` : '',
        verifyOutcome.combinedLog,
    ]
        .filter(Boolean)
        .join('\n\n');
    const finishedIso = new Date().toISOString();
    const computedDurationMs = params.durationMs ??
        Math.max(0, Date.parse(finishedIso) - Date.parse(runSnapshot.started_at));
    const effectiveExitReason = effectiveExecutionStatus === 'canceled'
        ? classifyExitReason({ executionStatus: 'canceled', exitCode: params.exitCode })
        : (params.exitReason ??
            classifyExitReason({
                executionStatus: effectiveExecutionStatus,
                exitCode: params.exitCode,
            }));
    let spawnedQueuedRunSpec = null;
    let publishedRevision = 0;
    mutateTaskRecord(archive, taskId, (task) => {
        const run = task.runs.find((r) => r.run_id === runId);
        if (!run)
            return;
        if (run.published_revision !== null) {
            publishedRevision = run.published_revision;
            return;
        }
        const effectiveModel = params.resolvedModel !== undefined ? params.resolvedModel : (run.resolved_model ?? null);
        const effectiveSource = params.modelSource ?? run.model_source ?? (run.requested_model ? 'explicit' : 'codex_cli_default');
        const effectiveEffort = params.reasoningEffort !== undefined ? params.reasoningEffort : (run.reasoning_effort ?? null);
        const nextRev = task.current_revision + 1;
        publishedRevision = nextRev;
        const terminalStatus = effectiveExecutionStatus === 'succeeded' ? 'completed'
            : effectiveExecutionStatus === 'canceled' ? 'canceled' : 'failed';
        recordActivity('phase', 'completed', terminalStatus);
        const summary = boundActivitySummary(archive.readRunActivities(taskId, runId));
        archive.publishImmutableRevision({
            taskId,
            runId,
            revision: nextRev,
            ledgerPatch: ledgerDiff.fullPatch,
            deltaPatch: deltaDiff.fullPatch,
            ledgerPerFilePatches: ledgerDiff.perFilePatches,
            deltaPerFilePatches: deltaDiff.perFilePatches,
            ...(execDeltaDiff ? { execDeltaPatch: execDeltaDiff.fullPatch } : {}),
            ...(verifySideDiff ? { verifySideEffectPatch: verifySideDiff.fullPatch } : {}),
            verifyLogs: combinedLogs,
            ...(shouldVerify && fs.existsSync(runPaths.verifyLogFile)
                ? { verifyLogSourceFile: runPaths.verifyLogFile }
                : {}),
            rawTraceSourceFile: runPaths.rawTraceFile,
            metadataWithoutRecall: {
                task_id: taskId,
                run_id: runId,
                revision: nextRev,
                published_at: finishedIso,
                from_tree_oid: task.latest_tree_oid,
                exec_tree_oid: execSnap.tree_oid,
                final_tree_oid: finalSnap.tree_oid,
                baseline_tree_oid: task.baseline_snapshot.tree_oid,
                execution_status: effectiveExecutionStatus,
                reported_status: params.reportedStatus,
                verification_status: verifyOutcome.status,
                exit_code: params.exitCode,
                exit_reason: effectiveExitReason,
                duration_ms: computedDurationMs,
                resolved_model: effectiveModel,
                model_source: effectiveSource,
                reasoning_effort: effectiveEffort,
                ledger_totals: ledgerDiff.totals,
                ledger_files: ledgerDiff.files,
                delta_totals: deltaDiff.totals,
                delta_files: deltaDiff.files,
                ...(execDeltaDiff
                    ? {
                        exec_delta_totals: execDeltaDiff.totals,
                        exec_delta_files: execDeltaDiff.files,
                    }
                    : {}),
                unexpected_files: unexpectedFiles,
                guard_signals: deltaDiff.guardSignals,
                external_drift_files: driftDiff ? driftDiff.files.map((f) => f.path) : [],
                verify_side_effect_files: verifySideDiff ? verifySideDiff.files.map((f) => f.path) : [],
                verify_results: verifyOutcome.results,
                unverified_blockers: params.blockers,
                unverified_counter_evidence: params.counterEvidence,
                native_events: effectiveNativeEvents,
                snapshot_notes: finalSnap.scope_notes,
                usage: params.usage,
                activities: summary.activities,
                activities_omitted_count: summary.omitted_count,
            },
        });
        run.status = effectiveExecutionStatus;
        run.phase = 'completed';
        run.finished_at = finishedIso;
        run.published_revision = nextRev;
        run.exit_code = params.exitCode;
        run.exit_reason = effectiveExitReason;
        run.duration_ms = computedDurationMs;
        run.resolved_model = effectiveModel;
        run.model_source = effectiveSource;
        run.reasoning_effort = effectiveEffort;
        if (params.lastEvent) {
            run.last_event = params.lastEvent;
            run.last_event_at = finishedIso;
        }
        run.error_summary = params.stderrSummary || null;
        task.current_revision = nextRev;
        task.latest_tree_oid = finalSnap.tree_oid;
        // Check FIFO steer queue if execution was not explicitly canceled
        const queue = Array.isArray(task.queued_steers)
            ? [...task.queued_steers]
            : task.queued_steer
                ? [task.queued_steer]
                : [];
        if (queue.length > 0 && effectiveExecutionStatus !== 'canceled' && !run.cancel_requested_at) {
            const queued = queue.shift();
            task.queued_steers = queue;
            task.queued_steer = queue[0] ?? null;
            if (queued.caller) {
                task.caller = { ...(task.caller ?? {}), ...queued.caller };
            }
            if (queued.model) {
                task.preferred_model = queued.model;
            }
            if (queued.reasoning_effort) {
                task.preferred_reasoning_effort = queued.reasoning_effort;
            }
            let resumeThreadId = task.active_thread_id;
            let mode = 'resume';
            if (queued.reset_context) {
                if (task.active_thread_id) {
                    task.archived_thread_ids.push(task.active_thread_id);
                }
                task.active_thread_id = null;
                resumeThreadId = null;
                mode = 'reset_context';
            }
            else if (!resumeThreadId) {
                mode = 'reset_context';
            }
            const nextSeq = task.runs.length + 1;
            const nextRunId = `run_${nextSeq}`;
            const nextModel = queued.model ?? task.preferred_model ?? null;
            const nextEffort = queued.reasoning_effort ?? task.preferred_reasoning_effort ?? null;
            const previewModel = resolveEffectiveCodexModel({
                requestedModel: nextModel,
                requestedEffort: nextEffort,
                threadId: resumeThreadId,
            });
            const prompt = buildFollowUpRunPrompt({
                objective: task.objective,
                contract: task.contract,
                instruction: queued.instruction,
                resumeThreadId,
                changedFilesFromBaseline: ledgerDiff.files.map((f) => f.path),
            });
            const nextRunPaths = archive.runPaths(taskId, nextRunId);
            const spec = {
                data_dir: archive.dataDir,
                task_id: taskId,
                run_id: nextRunId,
                execution_workspace: task.execution_workspace,
                prompt,
                resume_thread_id: resumeThreadId,
                model: nextModel,
                reasoning_effort: nextEffort,
                timeout_ms: 30 * 60 * 1000,
            };
            writeAtomicJson(nextRunPaths.specFile, spec);
            const nextRun = {
                run_id: nextRunId,
                task_id: taskId,
                sequence: nextSeq,
                mode,
                instruction: queued.instruction,
                status: 'running',
                phase: 'starting',
                thread_id: resumeThreadId,
                resumed_from_thread_id: resumeThreadId,
                worker_pid: null,
                worker_identity: null,
                target_pid: null,
                started_at: new Date().toISOString(),
                finished_at: null,
                cancel_requested_at: null,
                pre_run_tree_oid: finalSnap.tree_oid,
                published_revision: null,
                exit_code: null,
                exit_reason: null,
                duration_ms: null,
                error_summary: null,
                requested_model: nextModel,
                resolved_model: previewModel.resolvedModel,
                model_source: previewModel.modelSource,
                reasoning_effort: previewModel.reasoningEffort,
                last_event: 'queued steer dispatched',
                last_event_at: new Date().toISOString(),
            };
            task.runs.push(nextRun);
            task.active_run_id = nextRunId;
            task.state = 'running';
            spawnedQueuedRunSpec = spec;
        }
        else {
            task.queued_steers = [];
            task.queued_steer = null;
            task.active_run_id = null;
            task.state = 'idle';
        }
    });
    if (spawnedQueuedRunSpec) {
        const specToLaunch = spawnedQueuedRunSpec;
        const spawned = spawnDetachedRunWorker(specToLaunch);
        mutateTaskRecord(archive, taskId, (task) => {
            const r = task.runs.find((x) => x.run_id === specToLaunch.run_id);
            if (r && r.worker_pid === null) {
                r.worker_pid = spawned.pid;
                r.worker_identity = spawned.identity;
            }
        });
    }
    return { publishedRevision, spawnedQueuedRunSpec };
}
export function buildFollowUpRunPrompt(params) {
    if (params.resumeThreadId) {
        return buildResumeSteerPrompt(params.instruction);
    }
    return buildInitialDelegationPrompt({
        objective: params.objective,
        contract: params.contract,
        resetInstruction: params.instruction,
        existingChangedFiles: params.changedFilesFromBaseline,
    });
}
