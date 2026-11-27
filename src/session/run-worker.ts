#!/usr/bin/env node
import fs from 'node:fs';
import {
  captureProcessIdentity,
  classifyExitReason,
  runNativeCodexTurn,
} from '../adapters/index.js';
import { ArchiveStore, readJsonWithRetry } from '../observability/index.js';
import {
  finalizeRunAndPublishRevision,
  mutateTaskRecord,
  type WorkerRunSpec,
} from './run-finalizer.js';

async function runDetachedWorkerMain(): Promise<void> {
  const [, , dataDir, taskId, runId] = process.argv;
  if (!dataDir || !taskId || !runId) {
    process.exitCode = 2;
    return;
  }

  const archive = new ArchiveStore(dataDir);
  const runPaths = archive.runPaths(taskId, runId);
  if (!fs.existsSync(runPaths.specFile)) {
    process.exitCode = 2;
    return;
  }

  const spec = readJsonWithRetry<WorkerRunSpec>(runPaths.specFile);

  mutateTaskRecord(archive, taskId, (task) => {
    const run = task.runs.find((r) => r.run_id === runId);
    if (run) {
      run.worker_pid = process.pid;
      if (!run.worker_identity || run.worker_identity.pid !== process.pid) {
        run.worker_identity =
          process.platform === 'win32'
            ? { pid: process.pid, born: 'unknown' }
            : captureProcessIdentity(process.pid);
      }
      run.phase = 'starting';
    }
  });

  const abortController = new AbortController();
  const checkCancelFlag = () => {
    if (fs.existsSync(runPaths.cancelFlagFile) && !abortController.signal.aborted) {
      abortController.abort();
    }
  };
  const cancelPoll = setInterval(checkCancelFlag, 120);
  const onSignal = () => abortController.abort();
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);

  let lastEventFlushMs = 0;

  try {
    archive.appendRunActivity(taskId, runId, {
      at: new Date().toISOString(), kind: 'phase', label: 'starting', status: 'started',
    });
    checkCancelFlag();
    const adapterResult = await runNativeCodexTurn({
      executionWorkspace: spec.execution_workspace,
      prompt: spec.prompt,
      resumeThreadId: spec.resume_thread_id,
      model: spec.model,
      reasoningEffort: spec.reasoning_effort,
      outputSchemaFile: runPaths.outputSchemaFile,
      lastMessageFile: runPaths.lastMessageFile,
      rawTraceFile: runPaths.rawTraceFile,
      stderrFile: runPaths.stderrFile,
      timeoutMs: spec.timeout_ms,
      signal: abortController.signal,
      onChildSpawned(pid) {
        mutateTaskRecord(archive, taskId, (task) => {
          const run = task.runs.find((r) => r.run_id === runId);
          if (run) run.target_pid = pid;
        });
      },
      onThreadStarted(threadId) {
        mutateTaskRecord(archive, taskId, (task) => {
          const run = task.runs.find((r) => r.run_id === runId);
          if (run) run.thread_id = threadId;
          task.active_thread_id = threadId;
        });
      },
      onModelResolved(info) {
        mutateTaskRecord(archive, taskId, (task) => {
          const run = task.runs.find((r) => r.run_id === runId);
          if (run) {
            run.resolved_model = info.resolvedModel;
            run.model_source = info.modelSource;
            run.reasoning_effort = info.reasoningEffort;
          }
        });
      },
      onPhaseChanged(phase) {
        mutateTaskRecord(archive, taskId, (task) => {
          const run = task.runs.find((r) => r.run_id === runId);
          if (run && run.status === 'running') run.phase = phase;
        });
      },
      onActivity(activity) {
        archive.appendRunActivity(taskId, runId, activity);
      },
      onLiveEvent(summary) {
        const nowMs = Date.now();
        if (nowMs - lastEventFlushMs < 350) return;
        lastEventFlushMs = nowMs;
        mutateTaskRecord(archive, taskId, (task) => {
          const run = task.runs.find((r) => r.run_id === runId);
          if (run && run.status === 'running') {
            run.last_event = summary;
            run.last_event_at = new Date(nowMs).toISOString();
          }
        });
      },
    });

    await finalizeRunAndPublishRevision({
      archive,
      taskId,
      runId,
      executionStatus: adapterResult.executionStatus,
      reportedStatus: adapterResult.reportedStatus,
      blockers: adapterResult.report?.blockers ?? [],
      counterEvidence: adapterResult.report?.counter_evidence ?? [],
      nativeEvents: adapterResult.nativeEvents,
      exitCode: adapterResult.exitCode,
      exitReason: adapterResult.exitReason,
      durationMs: adapterResult.durationMs,
      resolvedModel: adapterResult.resolvedModel,
      modelSource: adapterResult.modelSource,
      reasoningEffort: adapterResult.reasoningEffort,
      lastEvent: adapterResult.lastEvent,
      usage: adapterResult.usage,
      stderrSummary: adapterResult.stderrSummary,
      signal: abortController.signal,
    });
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    const execStatus = abortController.signal.aborted ? 'canceled' : 'failed';
    await finalizeRunAndPublishRevision({
      archive,
      taskId,
      runId,
      executionStatus: execStatus,
      reportedStatus: 'missing',
      blockers: [],
      counterEvidence: [],
      nativeEvents: [{ source: 'native_harness_event', message: `Worker exception: ${errMsg}` }],
      exitCode: 1,
      exitReason: classifyExitReason({
        executionStatus: execStatus,
        exitCode: 1,
        spawnError: /not found|launch|ENOENT/i.test(errMsg),
      }),
      usage: null,
      stderrSummary: errMsg,
      skipVerification: abortController.signal.aborted,
      signal: abortController.signal,
    });
  } finally {
    clearInterval(cancelPoll);
    process.removeListener('SIGTERM', onSignal);
    process.removeListener('SIGINT', onSignal);
  }
}

void runDetachedWorkerMain();
