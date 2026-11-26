import type {
  BudgetOptions,
  ChangedFileEntry,
  RevisionMetadata,
  RunRecord,
  TaskRecord,
} from '../types.js';
import { classifyExitReason, resolveEffectiveCodexModel } from '../adapters/index.js';
import { computeTreeDiff, splitUnifiedDiffByFile } from '../evidence/diff-analyzer.js';
import type { ArchiveStore, PaginatedRecallSlice } from '../observability/archive-store.js';
import { redactSensitiveText } from '../observability/redact.js';
import type { PassboxBoardSnapshot } from '../session/session-manager.js';
import {
  DEFAULT_BUDGETS,
  mcpWireSerializedBytes,
  resolveBudgets,
  serializeWithinBudget,
  truncateByBytesAndLines,
  truncateUtf8ByBytes,
  utf8ByteLength,
} from './budgets.js';

function compactFileList(
  files: ChangedFileEntry[],
  maxItems: number
): { items: ChangedFileEntry[]; omittedCount: number } {
  if (files.length <= maxItems) {
    return { items: files, omittedCount: 0 };
  }
  return {
    items: files.slice(0, maxItems),
    omittedCount: files.length - maxItems,
  };
}

export class EvidenceFirewall {
  private readonly archive: ArchiveStore;

  constructor(archive: ArchiveStore) {
    this.archive = archive;
  }

  /**
   * Formats `passbox_status` response strictly <= 512 UTF-8 bytes.
   */
  formatStatusResponse(task: TaskRecord, activeRun: RunRecord | null): string {
    const hasQueuedSteer = Boolean(task.queued_steer || task.queued_steers?.length);
    const targetRun = activeRun ?? task.runs.at(-1) ?? null;
    const execStatus = targetRun?.status ?? 'succeeded';
    const exitInfo =
      targetRun?.exit_reason ??
      classifyExitReason({
        executionStatus: execStatus,
        exitCode: targetRun?.exit_code ?? null,
      });
    const modelName = targetRun?.resolved_model ?? task.preferred_model ?? null;

    const base: Record<string, unknown> = {
      task_id: task.task_id,
      state: task.state,
      revision: task.current_revision,
      run_id: targetRun?.run_id ?? null,
      execution_status: execStatus,
      phase: activeRun?.phase ?? (task.state === 'idle' ? 'idle' : 'running'),
      ...(exitInfo.code !== 'running' && exitInfo.code !== 'normal'
        ? { exit_reason: exitInfo.code, exit_code: exitInfo.exit_code }
        : {}),
      ...(modelName ? { model: truncateUtf8ByBytes(modelName, 36).text } : {}),
      queued_steer: hasQueuedSteer,
      updated_at: task.updated_at,
    };

    return serializeWithinBudget(base, DEFAULT_BUDGETS.statusBytes, () => ({
      task_id: truncateUtf8ByBytes(task.task_id, 48).text,
      state: task.state,
      revision: task.current_revision,
      execution_status: execStatus,
      ...(exitInfo.code !== 'running' && exitInfo.code !== 'normal'
        ? { exit_reason: exitInfo.code }
        : {}),
      queued_steer: hasQueuedSteer,
    }));
  }

  /**
   * Formats fleet-level `passbox_status({})` model-facing text strictly <= 512 UTF-8 bytes.
   */
  formatFleetStatusResponse(board: PassboxBoardSnapshot): string {
    const latest = board.tasks[0] ?? null;
    const payload: Record<string, unknown> = {
      total_tasks: board.summary.total_tasks,
      running_tasks: board.summary.running_tasks,
      idle_tasks: board.summary.idle_tasks,
      failed_tasks: board.summary.failed_or_interrupted_tasks,
      ...(board.default_codex_model.resolved_model
        ? { default_model: truncateUtf8ByBytes(board.default_codex_model.resolved_model, 40).text }
        : {}),
      ...(latest
        ? {
            latest_task_id: truncateUtf8ByBytes(latest.task_id, 48).text,
            latest_state: latest.state,
            latest_revision: latest.current_revision,
            latest_phase: latest.executor.phase,
          }
        : {}),
    };
    return serializeWithinBudget(payload, DEFAULT_BUDGETS.statusBytes, () => ({
      total_tasks: board.summary.total_tasks,
      running_tasks: board.summary.running_tasks,
      idle_tasks: board.summary.idle_tasks,
    }));
  }

  /**
   * Bounds MCP App `structuredContent` safely below 240 KiB (well within Antigravity's 1 MiB trajectory cap).
   */
  boundBoardStructuredContent(board: PassboxBoardSnapshot): Record<string, unknown> {
    const maxBytes = 240 * 1024;
    const direct = JSON.stringify(board);
    if (utf8ByteLength(direct) <= maxBytes) {
      return board as unknown as Record<string, unknown>;
    }
    const trimmedTasks = board.tasks.slice(0, 8).map((t) => ({
      ...t,
      runs: t.runs.slice(-4).map((r) => ({
        ...r,
        delta_files: r.delta_files.slice(0, 6),
        unverified_blockers: r.unverified_blockers.slice(0, 6),
        unverified_counter_evidence: r.unverified_counter_evidence.slice(0, 6),
      })),
    }));
    return {
      ...board,
      tasks: trimmedTasks,
      board_clamped: true,
    };
  }

  /**
   * Formats `passbox_collect` response separating execution_status, reported_status,
   * verification_status, exit_reason, model metadata, deterministic observations,
   * untrusted artifacts, and unverified_claims.
   */
  formatCollectResponse(params: {
    task: TaskRecord;
    activeRun: RunRecord | null;
    sinceRevision?: number;
    budget?: BudgetOptions;
    waitedMs: number;
  }): string {
    const { task, activeRun, sinceRevision, budget, waitedMs } = params;
    const budgets = resolveBudgets(budget);

    // Case 1: No revision has been published yet (first run still running)
    if (task.current_revision === 0) {
      const modelInfo = resolveEffectiveCodexModel({
        requestedModel: activeRun?.requested_model ?? task.preferred_model,
        requestedEffort: activeRun?.reasoning_effort ?? task.preferred_reasoning_effort,
        threadId: activeRun?.thread_id ?? task.active_thread_id,
      });
      const payload: Record<string, unknown> = {
        task_id: task.task_id,
        state: task.state,
        revision: 0,
        active_run_id: activeRun?.run_id ?? null,
        phase: activeRun?.phase ?? 'running',
        ...(activeRun?.last_event ? { last_event: activeRun.last_event } : {}),
        model: activeRun?.resolved_model ?? modelInfo.resolvedModel,
        model_source: activeRun?.model_source ?? modelInfo.modelSource,
        ...(activeRun?.reasoning_effort ?? modelInfo.reasoningEffort
          ? { reasoning_effort: activeRun?.reasoning_effort ?? modelInfo.reasoningEffort }
          : {}),
        waited_ms: waitedMs,
        execution_status: activeRun?.status ?? 'running',
        reported_status: 'missing',
        verification_status: 'not_run',
        unchanged: sinceRevision === 0,
        note: 'Initial run is still in progress; call passbox_collect again to wait for revision 1.',
      };
      return serializeWithinBudget(payload, budgets.hardMaxBytes, () => payload);
    }

    const latestMeta = this.archive.readRevisionMetadata(task.task_id, task.current_revision);
    const matchingRun = task.runs.find((r) => r.run_id === latestMeta.run_id) ?? null;
    const exitCode = latestMeta.exit_code ?? matchingRun?.exit_code ?? null;
    const exitReason =
      latestMeta.exit_reason ??
      matchingRun?.exit_reason ??
      classifyExitReason({
        executionStatus: latestMeta.execution_status,
        exitCode,
      });
    const durationMs =
      latestMeta.duration_ms ??
      matchingRun?.duration_ms ??
      (matchingRun?.finished_at
        ? Math.max(0, Date.parse(matchingRun.finished_at) - Date.parse(matchingRun.started_at))
        : null);
    const resolvedModelInfo =
      latestMeta.resolved_model !== undefined || latestMeta.model_source !== undefined
        ? {
            resolvedModel: latestMeta.resolved_model ?? null,
            modelSource: latestMeta.model_source ?? 'codex_cli_default',
            reasoningEffort: latestMeta.reasoning_effort ?? null,
          }
        : resolveEffectiveCodexModel({
            requestedModel: matchingRun?.requested_model,
            requestedEffort: matchingRun?.reasoning_effort,
            threadId: matchingRun?.thread_id,
          });

    // Case 2: Caller already holds current_revision -> return compact unchanged response
    if (sinceRevision !== undefined && sinceRevision >= task.current_revision) {
      const unchangedPayload: Record<string, unknown> = {
        unchanged: true,
        task_id: task.task_id,
        state: task.state,
        revision: task.current_revision,
        since_revision: sinceRevision,
        active_run_id: activeRun?.run_id ?? null,
        ...(activeRun
          ? {
              active_run_phase: activeRun.phase,
              ...(activeRun.last_event ? { active_run_last_event: activeRun.last_event } : {}),
            }
          : {}),
        waited_ms: waitedMs,
        execution_status: activeRun ? 'running' : latestMeta.execution_status,
        latest_published_execution_status: latestMeta.execution_status,
        exit_code: exitCode,
        exit_reason: exitReason,
        reported_status: latestMeta.reported_status,
        verification_status: latestMeta.verification_status,
        model: activeRun?.resolved_model ?? resolvedModelInfo.resolvedModel,
        model_source: activeRun?.model_source ?? resolvedModelInfo.modelSource,
        recall_ids: latestMeta.recall_ids,
      };
      return serializeWithinBudget(unchangedPayload, budgets.hardMaxBytes, () => unchangedPayload);
    }

    // Case 3: Compute requested incremental view (sinceRevision -> current_revision)
    const effectiveSince =
      sinceRevision !== undefined && sinceRevision > 0 ? sinceRevision : 0;

    let deltaFiles = latestMeta.ledger_files;
    let deltaTotals = latestMeta.ledger_totals;
    let rawPreviewSource = '';
    const extraRecallIds: Record<string, string> = {};
    const extraSnapshotNotes: string[] = [];

    if (effectiveSince === 0) {
      deltaFiles = latestMeta.ledger_files;
      deltaTotals = latestMeta.ledger_totals;
      rawPreviewSource = this.buildFilteredPreviewPatch(
        task.task_id,
        task.current_revision,
        latestMeta.ledger_files,
        true
      );
    } else if (effectiveSince === task.current_revision - 1) {
      deltaFiles = latestMeta.delta_files;
      deltaTotals = latestMeta.delta_totals;
      rawPreviewSource = this.buildFilteredPreviewPatch(
        task.task_id,
        task.current_revision,
        latestMeta.delta_files,
        false
      );
    } else {
      // Multi-revision jump (e.g., r1 -> r3)
      const sinceMeta = this.archive.readRevisionMetadata(task.task_id, effectiveSince);
      try {
        const rangeDiff = computeTreeDiff(
          task.execution_workspace,
          sinceMeta.final_tree_oid,
          latestMeta.final_tree_oid
        );
        const rangeRecall = this.archive.ensureRangeDiffRecall({
          taskId: task.task_id,
          fromRevision: effectiveSince,
          toRevision: task.current_revision,
          fullPatch: rangeDiff.fullPatch,
          perFilePatches: rangeDiff.perFilePatches,
        });
        extraRecallIds.range_diff = rangeRecall.rangeDiffRecallId;
        deltaFiles = rangeDiff.files.map((f) => {
          const fileRecallId = rangeRecall.fileRecallIds.get(f.path);
          return fileRecallId ? { ...f, recall_id: fileRecallId } : f;
        });
        deltaTotals = rangeDiff.totals;
        rawPreviewSource = rangeDiff.previewEligiblePatch;
      } catch {
        const chunks: string[] = [];
        const aggregatedByPath = new Map<string, ChangedFileEntry>();
        let summedIns = 0;
        let summedDel = 0;
        for (let r = effectiveSince + 1; r <= task.current_revision; r++) {
          const rMeta = this.archive.readRevisionMetadata(task.task_id, r);
          summedIns += rMeta.delta_totals.insertions;
          summedDel += rMeta.delta_totals.deletions;
          for (const f of rMeta.delta_files) {
            aggregatedByPath.set(f.path, f);
          }
          const filteredChunk = this.buildFilteredPreviewPatch(
            task.task_id,
            r,
            rMeta.delta_files,
            false
          );
          if (filteredChunk.trim()) {
            chunks.push(filteredChunk.trimEnd());
          }
        }
        rawPreviewSource = chunks.length ? `${chunks.join('\n')}\n` : '';
        deltaFiles = Array.from(aggregatedByPath.values()).sort((a, b) =>
          a.path.localeCompare(b.path)
        );
        deltaTotals = {
          files_changed: deltaFiles.length,
          insertions: summedIns,
          deletions: summedDel,
          net_lines: summedIns - summedDel,
        };
        extraSnapshotNotes.push(
          `Git tree diff unavailable for r${effectiveSince}->r${task.current_revision}; fell back to archived per-revision deltas.`
        );
      }
    }

    const omittedFiles = deltaFiles
      .filter((f) => f.omitted_from_preview)
      .map((f) => ({
        path: f.path,
        status: f.status,
        insertions: f.insertions,
        deletions: f.deletions,
        omit_reason: f.omit_reason,
        recall_id:
          f.recall_id ?? extraRecallIds.range_diff ?? latestMeta.recall_ids.diff,
      }));

    // Bound observations summary within summaryBytes (~2 KiB target)
    let fileCap = 20;
    let observations = this.buildObservationsObject(
      latestMeta,
      effectiveSince,
      deltaTotals,
      deltaFiles,
      fileCap,
      extraSnapshotNotes
    );
    while (utf8ByteLength(JSON.stringify(observations)) > budgets.summaryBytes && fileCap > 3) {
      fileCap = Math.max(3, Math.floor(fileCap / 2));
      observations = this.buildObservationsObject(
        latestMeta,
        effectiveSince,
        deltaTotals,
        deltaFiles,
        fileCap,
        extraSnapshotNotes
      );
    }

    // Bound diff + verify preview within previewBytes / previewLines (12 KiB / 300 lines)
    const boundedDiff = truncateByBytesAndLines(
      rawPreviewSource,
      Math.max(512, budgets.previewBytes - 1024),
      budgets.previewLines
    );

    const verifySummaries = latestMeta.verify_results.map((v) => ({
      index: v.index,
      argv: v.argv.slice(0, 8),
      exit_code: v.exit_code,
      timed_out: v.timed_out,
      duration_ms: v.duration_ms,
      output_excerpt: truncateUtf8ByBytes(v.output_excerpt, 600).text,
    }));

    const unverifiedClaims = {
      source: 'executor_model_self_report',
      verified: false,
      blockers: latestMeta.unverified_blockers.slice(0, 10).map((b) => ({
        claim: truncateUtf8ByBytes(b.claim, 240).text,
        evidence: b.evidence ? truncateUtf8ByBytes(b.evidence, 160).text : null,
      })),
      counter_evidence: latestMeta.unverified_counter_evidence.slice(0, 10).map((c) => ({
        claim: truncateUtf8ByBytes(c.claim, 240).text,
        evidence: c.evidence ? truncateUtf8ByBytes(c.evidence, 160).text : null,
      })),
      native_events: latestMeta.native_events.slice(0, 5).map((e) => ({
        source: e.source,
        message: truncateUtf8ByBytes(e.message, 240).text,
      })),
    };

    const combinedRecallIds = {
      ...latestMeta.recall_ids,
      ...extraRecallIds,
    };

    const fullPayload: Record<string, unknown> = {
      unchanged: false,
      task_id: task.task_id,
      run_id: latestMeta.run_id,
      state: task.state,
      ...(activeRun ? { active_run_id: activeRun.run_id, active_run_phase: activeRun.phase } : {}),
      workspace_mode: task.workspace_mode,
      execution_workspace: task.execution_workspace,
      revision: task.current_revision,
      since_revision: effectiveSince,
      waited_ms: waitedMs,
      duration_ms: durationMs,
      model: resolvedModelInfo.resolvedModel,
      model_source: resolvedModelInfo.modelSource,
      ...(resolvedModelInfo.reasoningEffort
        ? { reasoning_effort: resolvedModelInfo.reasoningEffort }
        : {}),
      execution_status: latestMeta.execution_status,
      exit_code: exitCode,
      exit_reason: exitReason,
      reported_status: latestMeta.reported_status,
      verification_status: latestMeta.verification_status,
      observations,
      artifacts: {
        trust: 'untrusted_artifact_data',
        diff_preview: boundedDiff.text,
        diff_truncated: boundedDiff.truncated || omittedFiles.length > 0,
        diff_lines_shown: boundedDiff.keptLines,
        diff_lines_total: boundedDiff.totalLines,
        omitted_files: omittedFiles.slice(0, 20),
        omitted_files_total: omittedFiles.length,
        verify_commands: verifySummaries.slice(0, 5),
        recall_ids: combinedRecallIds,
      },
      unverified_claims: unverifiedClaims,
    };

    // Enforce global hard ceiling (32 KiB wire-serialized default)
    return serializeWithinBudget(fullPayload, budgets.hardMaxBytes, (_actual, cap) => {
      const tighterDiff = truncateByBytesAndLines(
        rawPreviewSource,
        Math.max(512, Math.floor(cap * 0.25)),
        60
      );
      return {
        ...fullPayload,
        budget_clamped: true,
        observations: this.buildObservationsObject(
          latestMeta,
          effectiveSince,
          deltaTotals,
          deltaFiles,
          5,
          extraSnapshotNotes
        ),
        artifacts: {
          trust: 'untrusted_artifact_data',
          diff_preview: tighterDiff.text,
          diff_truncated: true,
          omitted_files_total: omittedFiles.length,
          recall_ids: combinedRecallIds,
        },
      };
    });
  }

  private buildObservationsObject(
    latestMeta: RevisionMetadata,
    sinceRevision: number,
    deltaTotals: RevisionMetadata['delta_totals'],
    deltaFiles: ChangedFileEntry[],
    maxFiles: number,
    extraSnapshotNotes: string[] = []
  ): Record<string, unknown> {
    const ledgerCompact = compactFileList(latestMeta.ledger_files, maxFiles);
    const deltaCompact = compactFileList(deltaFiles, maxFiles);
    const notes = [...latestMeta.snapshot_notes, ...extraSnapshotNotes];
    return {
      ledger_t0_to_current: {
        totals: latestMeta.ledger_totals,
        files: ledgerCompact.items,
        ...(ledgerCompact.omittedCount > 0 ? { files_omitted_count: ledgerCompact.omittedCount } : {}),
      },
      delta_since_revision: {
        from_revision: sinceRevision,
        to_revision: latestMeta.revision,
        totals: deltaTotals,
        files: deltaCompact.items,
        ...(deltaCompact.omittedCount > 0 ? { files_omitted_count: deltaCompact.omittedCount } : {}),
      },
      unexpected_files: latestMeta.unexpected_files.slice(0, maxFiles),
      guard_signals: latestMeta.guard_signals,
      ...(latestMeta.external_drift_files.length > 0
        ? { external_drift_files: latestMeta.external_drift_files.slice(0, maxFiles) }
        : {}),
      ...(latestMeta.verify_side_effect_files.length > 0
        ? { verify_side_effect_files: latestMeta.verify_side_effect_files.slice(0, maxFiles) }
        : {}),
      ...(latestMeta.verify_side_effect_files.length > 0 && latestMeta.exec_delta_totals
        ? {
            exec_delta_before_verify: {
              totals: latestMeta.exec_delta_totals,
              files: compactFileList(latestMeta.exec_delta_files ?? [], maxFiles).items,
            },
          }
        : {}),
      ...(notes.length > 0 ? { snapshot_notes: notes.slice(0, 4) } : {}),
    };
  }

  private buildFilteredPreviewPatch(
    taskId: string,
    revision: number,
    files: ChangedFileEntry[],
    cumulative: boolean
  ): string {
    const eligiblePaths = files.filter((f) => !f.omitted_from_preview).map((f) => f.path);
    if (eligiblePaths.length === 0) return '';
    const scope = cumulative ? 'ledger' : 'delta';
    const perFile = this.archive.readPerFileDiffsMap(taskId, revision, eligiblePaths, scope);
    if (perFile.size === eligiblePaths.length) {
      return `${Array.from(perFile.values()).map((s) => s.trimEnd()).join('\n')}\n`;
    }
    const raw = this.archive.readRevisionDiffText(taskId, revision, cumulative);
    if (!files.some((f) => f.omitted_from_preview)) {
      return raw;
    }
    const parsedByFile = splitUnifiedDiffByFile(raw);
    const chunks: string[] = [];
    for (const p of eligiblePaths) {
      const patch = parsedByFile.get(p);
      if (patch) chunks.push(patch.trimEnd());
    }
    return chunks.length ? `${chunks.join('\n')}\n` : '';
  }

  /**
   * Paginates an immutable Recall artifact while guaranteeing the final wire-serialized
   * MCP JSON-RPC response never exceeds `limitBytes` (default 8 KiB, max 32 KiB) and
   * advances `next_cursor` by the exact UTF-8 byte count actually returned.
   */
  formatRecallResponse(recallId: string, cursor?: string, limitBytes?: number): string {
    const pageBudget = Math.max(
      1024,
      Math.min(limitBytes ?? DEFAULT_BUDGETS.recallBytes, DEFAULT_BUDGETS.hardMaxBytes)
    );
    let contentBudget = Math.max(128, Math.floor((pageBudget - 420) * 0.7));

    for (let attempt = 0; attempt < 14; attempt++) {
      const slice: PaginatedRecallSlice = this.archive.paginateRecall(
        recallId,
        cursor,
        contentBudget
      );
      const envelope: Record<string, unknown> = {
        trust: 'untrusted_artifact_data',
        ...slice,
      };
      const json = JSON.stringify(envelope);
      if (mcpWireSerializedBytes(json) <= pageBudget) {
        return json;
      }
      if (contentBudget <= 32) break;
      contentBudget = Math.max(32, Math.floor(contentBudget * 0.6));
    }

    const minimalSlice = this.archive.paginateRecall(recallId, cursor, 32);
    return serializeWithinBudget(
      { trust: 'untrusted_artifact_data', ...minimalSlice },
      pageBudget,
      () => ({
        trust: 'untrusted_artifact_data',
        recall_id: minimalSlice.recall_id,
        cursor: minimalSlice.cursor,
        next_cursor: minimalSlice.next_cursor,
        has_more: minimalSlice.has_more,
        content: truncateUtf8ByBytes(minimalSlice.content, 32).text,
      })
    );
  }

  /**
   * Formats simple control responses (`delegate`, `steer`, `cancel`) within budget.
   */
  formatControlResponse(payload: Record<string, unknown>, maxBytes = 4096): string {
    return serializeWithinBudget(payload, maxBytes, () => ({
      ...payload,
      truncated: true,
    }));
  }

  /**
   * Formats any tool/validation/runtime error within budget while archiving full diagnostic text.
   */
  formatErrorResponse(
    taskId: string | null,
    error: unknown,
    maxBytes = 2048
  ): { text: string; isError: true } {
    const rawMsg = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error);
    const cleanSummary = redactSensitiveText(
      error instanceof Error ? error.message : String(error)
    );
    let diagnosticRecallId: string | undefined;
    if (utf8ByteLength(rawMsg) > 400) {
      try {
        diagnosticRecallId = this.archive.archiveDiagnosticError(taskId, rawMsg);
      } catch {}
    }

    const errPayload: Record<string, unknown> = {
      error: true,
      ...(taskId ? { task_id: taskId } : {}),
      message: truncateUtf8ByBytes(cleanSummary, Math.max(120, maxBytes - 220)).text,
      ...(diagnosticRecallId ? { diagnostic_recall_id: diagnosticRecallId } : {}),
    };

    const text = serializeWithinBudget(errPayload, maxBytes, () => ({
      error: true,
      ...(taskId ? { task_id: truncateUtf8ByBytes(taskId, 48).text } : {}),
      message: truncateUtf8ByBytes(cleanSummary, 160).text,
      ...(diagnosticRecallId ? { diagnostic_recall_id: diagnosticRecallId } : {}),
    }));
    return { text, isError: true };
  }
}
