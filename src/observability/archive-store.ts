import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type {
  CoordinatorActivityRecord,
  RecallIndexEntry,
  RevisionMetadata,
  RunActivityItem,
} from '../types.js';
import { readJsonWithRetry, writeAtomicJson, writeAtomicText } from './fs-atomic.js';
import { redactSensitiveText } from './redact.js';
import { sanitizeActivityItem } from '../firewall/budgets.js';

export function resolvePluginDataDir(explicitDataDir?: string): string {
  const raw =
    explicitDataDir ||
    process.env.PASSBOX_DATA_DIR ||
    process.env.PLUGIN_DATA ||
    path.join(os.homedir(), '.gemini', 'antigravity', 'plugin-data', 'passbox');
  const resolved = path.resolve(raw);
  fs.mkdirSync(resolved, { recursive: true });
  return resolved;
}

export function shortHash(input: string, len = 10): string {
  return createHash('sha256').update(input, 'utf8').digest('hex').slice(0, len);
}

export interface RunArtifactPaths {
  runDir: string;
  specFile: string;
  rawTraceFile: string;
  activitiesFile: string;
  stderrFile: string;
  verifyLogFile: string;
  lastMessageFile: string;
  outputSchemaFile: string;
  cancelFlagFile: string;
}

export interface PublishRevisionInput {
  taskId: string;
  runId: string;
  revision: number;
  ledgerPatch: string;
  deltaPatch: string;
  perFilePatches?: Map<string, string>;
  ledgerPerFilePatches?: Map<string, string>;
  deltaPerFilePatches?: Map<string, string>;
  execDeltaPatch?: string;
  verifySideEffectPatch?: string;
  verifyLogs: string;
  verifyLogSourceFile?: string;
  rawTraceSourceFile: string;
  metadataWithoutRecall: Omit<RevisionMetadata, 'recall_ids'>;
}

export interface PaginatedRecallSlice {
  recall_id: string;
  task_id: string;
  revision: number;
  kind: RecallIndexEntry['kind'];
  target_path?: string;
  content: string;
  cursor: string;
  next_cursor: string | null;
  has_more: boolean;
  total_bytes: number;
  returned_bytes: number;
}

/**
 * Aligns a byte slice of a UTF-8 Buffer so multi-byte characters are never split
 * across pages. `start` is aligned if needed, and `end` backs up at most 3 bytes
 * to avoid cutting a multi-byte sequence mid-codepoint.
 */
export function sliceUtf8BufferAligned(
  buf: Buffer,
  startByte: number,
  maxBytes: number
): { text: string; nextOffset: number } {
  const len = buf.length;
  const start = Math.max(0, Math.min(startByte, len));
  if (start >= len || maxBytes <= 0) {
    return { text: '', nextOffset: len };
  }
  let end = Math.min(len, start + maxBytes);
  if (end < len) {
    // If buf[end] is a UTF-8 continuation byte (0b10xxxxxx), step backward to the lead byte.
    let backtrack = 0;
    while (end > start && backtrack < 3 && (buf[end] & 0xc0) === 0x80) {
      end--;
      backtrack++;
    }
    if (end === start) {
      end = Math.min(len, start + maxBytes);
    }
  }
  return {
    text: buf.subarray(start, end).toString('utf8'),
    nextOffset: end,
  };
}

export class ArchiveStore {
  readonly dataDir: string;

  constructor(explicitDataDir?: string) {
    this.dataDir = resolvePluginDataDir(explicitDataDir);
  }

  tasksRootDir(): string {
    const p = path.join(this.dataDir, 'tasks');
    fs.mkdirSync(p, { recursive: true });
    return p;
  }

  worktreesRootDir(): string {
    const p = path.join(this.dataDir, 'worktrees');
    fs.mkdirSync(p, { recursive: true });
    return p;
  }

  recallRegistryDir(): string {
    const p = path.join(this.dataDir, 'recall');
    fs.mkdirSync(p, { recursive: true });
    return p;
  }

  globalLockDir(): string {
    return path.join(this.dataDir, 'locks', 'workspace-registry.lock');
  }

  taskDir(taskId: string): string {
    return path.join(this.tasksRootDir(), taskId);
  }

  taskLockDir(taskId: string): string {
    return path.join(this.taskDir(taskId), 'task.lock');
  }

  taskStateFile(taskId: string): string {
    return path.join(this.taskDir(taskId), 'task.json');
  }

  coordinatorStateFile(taskId: string): string {
    return path.join(this.taskDir(taskId), 'coordinator.json');
  }

  readCoordinatorActivity(taskId: string): CoordinatorActivityRecord | null {
    const file = this.coordinatorStateFile(taskId);
    if (!fs.existsSync(file)) return null;
    try {
      return readJsonWithRetry<CoordinatorActivityRecord>(file);
    } catch {
      return null;
    }
  }

  writeCoordinatorActivity(
    taskId: string,
    update: Partial<CoordinatorActivityRecord> & Pick<CoordinatorActivityRecord, 'last_action'>
  ): CoordinatorActivityRecord {
    const prev = this.readCoordinatorActivity(taskId);
    const next: CoordinatorActivityRecord = {
      caller: update.caller !== undefined ? update.caller : (prev?.caller ?? null),
      last_action: update.last_action,
      last_action_at: update.last_action_at ?? new Date().toISOString(),
      last_action_detail:
        update.last_action_detail !== undefined
          ? update.last_action_detail
          : (prev?.last_action_detail ?? null),
      collecting_since:
        update.collecting_since !== undefined ? update.collecting_since : null,
      collecting_until:
        update.collecting_until !== undefined ? update.collecting_until : null,
      collecting_wait_seconds:
        update.collecting_wait_seconds !== undefined ? update.collecting_wait_seconds : null,
    };
    try {
      if (fs.existsSync(this.taskDir(taskId))) {
        writeAtomicJson(this.coordinatorStateFile(taskId), next);
      }
    } catch {}
    return next;
  }

  listTaskIds(): string[] {
    const root = this.tasksRootDir();
    try {
      return fs
        .readdirSync(root, { withFileTypes: true })
        .filter((d) => d.isDirectory() && /^[A-Za-z0-9_-]{4,80}$/.test(d.name))
        .map((d) => d.name);
    } catch {
      return [];
    }
  }

  revisionDir(taskId: string, revision: number): string {
    return path.join(this.taskDir(taskId), 'revisions', `rev-${revision}`);
  }

  revisionMetaFile(taskId: string, revision: number): string {
    return path.join(this.revisionDir(taskId, revision), 'meta.json');
  }

  runPaths(taskId: string, runId: string): RunArtifactPaths {
    const runDir = path.join(this.taskDir(taskId), 'runs', runId);
    fs.mkdirSync(runDir, { recursive: true });
    return {
      runDir,
      specFile: path.join(runDir, 'spec.json'),
      rawTraceFile: path.join(runDir, 'raw_trace.jsonl'),
      activitiesFile: path.join(runDir, 'activities.jsonl'),
      stderrFile: path.join(runDir, 'stderr.log'),
      verifyLogFile: path.join(runDir, 'verify.log'),
      lastMessageFile: path.join(runDir, 'last_message.json'),
      outputSchemaFile: path.join(runDir, 'output_schema.json'),
      cancelFlagFile: path.join(runDir, 'cancel.flag'),
    };
  }

  appendRunActivity(taskId: string, runId: string, item: RunActivityItem): void {
    const clean = sanitizeActivityItem(item);
    if (!clean) return;
    const { activitiesFile } = this.runPaths(taskId, runId);
    const fd = fs.openSync(activitiesFile, 'a+');
    try {
      // Delimit a partial tail left by a worker that exited during a write.
      const { size } = fs.fstatSync(fd);
      const lastByte = Buffer.alloc(1);
      const partial = size > 0 && fs.readSync(fd, lastByte, 0, 1, size - 1) === 1 && lastByte[0] !== 10;
      fs.appendFileSync(fd, (partial ? '\n' : '') + JSON.stringify(clean) + '\n', 'utf8');
    } finally {
      fs.closeSync(fd);
    }
  }

  readRunActivities(taskId: string, runId: string): RunActivityItem[] {
    const file = path.join(this.taskDir(taskId), 'runs', runId, 'activities.jsonl');
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      return [];
    }
    const activities: RunActivityItem[] = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const item = sanitizeActivityItem(JSON.parse(line));
        if (item) activities.push(item);
      } catch {
        // A concurrent append or an interrupted worker can leave an incomplete line.
      }
    }
    return activities.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  }

  private registerRecallEntry(entry: RecallIndexEntry): void {
    const entryFile = path.join(this.recallRegistryDir(), `${entry.recall_id}.json`);
    writeAtomicJson(entryFile, entry);
  }

  makeDeltaFileRecallId(taskId: string, revision: number, filePath: string): string {
    return `rc_${taskId}_r${revision}_dfile_${shortHash(filePath, 8)}`;
  }

  makeLedgerFileRecallId(taskId: string, revision: number, filePath: string): string {
    return `rc_${taskId}_r${revision}_lfile_${shortHash(filePath, 8)}`;
  }

  makeRangeFileRecallId(
    taskId: string,
    fromRevision: number,
    toRevision: number,
    filePath: string
  ): string {
    return `rc_${taskId}_r${fromRevision}_to_r${toRevision}_file_${shortHash(filePath, 8)}`;
  }

  makeFileRecallId(taskId: string, revision: number, filePath: string): string {
    return this.makeDeltaFileRecallId(taskId, revision, filePath);
  }

  archiveDiagnosticError(taskId: string | null, rawErrorText: string): string {
    const id = `rc_diag_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    const diagDir = path.join(this.dataDir, 'diagnostics');
    fs.mkdirSync(diagDir, { recursive: true });
    const absFile = path.join(diagDir, `${id}.log`);
    const redacted = redactSensitiveText(rawErrorText);
    writeAtomicText(absFile, redacted);
    const rel = path.relative(this.dataDir, absFile);
    this.registerRecallEntry({
      recall_id: id,
      task_id: taskId ?? 'system',
      revision: 0,
      kind: 'diagnostic',
      file_path_rel: rel,
      byte_length: Buffer.byteLength(redacted, 'utf8'),
      created_at: new Date().toISOString(),
    });
    return id;
  }

  publishImmutableRevision(input: PublishRevisionInput): RevisionMetadata {
    const {
      taskId,
      revision,
      ledgerPatch,
      deltaPatch,
      perFilePatches,
      ledgerPerFilePatches,
      deltaPerFilePatches,
      execDeltaPatch,
      verifySideEffectPatch,
      verifyLogs,
      verifyLogSourceFile,
      rawTraceSourceFile,
      metadataWithoutRecall,
    } = input;

    const revDir = this.revisionDir(taskId, revision);
    const ledgerFilesDir = path.join(revDir, 'files', 'ledger');
    const deltaFilesDir = path.join(revDir, 'files', 'delta');
    fs.mkdirSync(ledgerFilesDir, { recursive: true });
    fs.mkdirSync(deltaFilesDir, { recursive: true });

    const now = new Date().toISOString();

    // 1. Persist cumulative ledger diff and incremental delta diff
    const ledgerFile = path.join(revDir, 'ledger.diff');
    const deltaFile = path.join(revDir, 'delta.diff');
    const logsFile = path.join(revDir, 'verify.log');
    const traceSnapFile = path.join(revDir, 'raw_trace.jsonl');

    writeAtomicText(ledgerFile, ledgerPatch);
    writeAtomicText(deltaFile, deltaPatch);

    const logParts: string[] = [];
    if (verifyLogs.trim()) {
      logParts.push(redactSensitiveText(verifyLogs.trim()));
    }
    if (verifyLogSourceFile && fs.existsSync(verifyLogSourceFile)) {
      const fileLogText = redactSensitiveText(fs.readFileSync(verifyLogSourceFile, 'utf8').trim());
      if (fileLogText) logParts.push(fileLogText);
    }
    const cleanLogs = logParts.join('\n\n');
    writeAtomicText(logsFile, cleanLogs);

    let traceContent = '';
    if (rawTraceSourceFile && fs.existsSync(rawTraceSourceFile)) {
      traceContent = redactSensitiveText(fs.readFileSync(rawTraceSourceFile, 'utf8'));
    }
    writeAtomicText(traceSnapFile, traceContent);

    // 2. Register core Recall IDs bound to (taskId, revision)
    const diffRecallId = `rc_${taskId}_r${revision}_diff`;
    const ledgerRecallId = `rc_${taskId}_r${revision}_ledger`;
    const logsRecallId = `rc_${taskId}_r${revision}_logs`;
    const traceRecallId = `rc_${taskId}_r${revision}_trace`;

    this.registerRecallEntry({
      recall_id: diffRecallId,
      task_id: taskId,
      revision,
      kind: 'diff',
      file_path_rel: path.relative(this.dataDir, deltaFile),
      byte_length: Buffer.byteLength(deltaPatch, 'utf8'),
      created_at: now,
    });
    this.registerRecallEntry({
      recall_id: ledgerRecallId,
      task_id: taskId,
      revision,
      kind: 'ledger_diff',
      file_path_rel: path.relative(this.dataDir, ledgerFile),
      byte_length: Buffer.byteLength(ledgerPatch, 'utf8'),
      created_at: now,
    });
    this.registerRecallEntry({
      recall_id: logsRecallId,
      task_id: taskId,
      revision,
      kind: 'logs',
      file_path_rel: path.relative(this.dataDir, logsFile),
      byte_length: Buffer.byteLength(cleanLogs, 'utf8'),
      created_at: now,
    });
    this.registerRecallEntry({
      recall_id: traceRecallId,
      task_id: taskId,
      revision,
      kind: 'raw_trace',
      file_path_rel: path.relative(this.dataDir, traceSnapFile),
      byte_length: Buffer.byteLength(traceContent, 'utf8'),
      created_at: now,
    });

    let execDiffRecallId: string | undefined;
    if (execDeltaPatch !== undefined) {
      const execDiffFile = path.join(revDir, 'exec_delta.diff');
      writeAtomicText(execDiffFile, execDeltaPatch);
      execDiffRecallId = `rc_${taskId}_r${revision}_exec_diff`;
      this.registerRecallEntry({
        recall_id: execDiffRecallId,
        task_id: taskId,
        revision,
        kind: 'exec_diff',
        file_path_rel: path.relative(this.dataDir, execDiffFile),
        byte_length: Buffer.byteLength(execDeltaPatch, 'utf8'),
        created_at: now,
      });
    }

    let verifySideEffectRecallId: string | undefined;
    if (verifySideEffectPatch !== undefined) {
      const verifyDiffFile = path.join(revDir, 'verify_side_effect.diff');
      writeAtomicText(verifyDiffFile, verifySideEffectPatch);
      verifySideEffectRecallId = `rc_${taskId}_r${revision}_verify_diff`;
      this.registerRecallEntry({
        recall_id: verifySideEffectRecallId,
        task_id: taskId,
        revision,
        kind: 'verify_side_effect_diff',
        file_path_rel: path.relative(this.dataDir, verifyDiffFile),
        byte_length: Buffer.byteLength(verifySideEffectPatch, 'utf8'),
        created_at: now,
      });
    }

    // 3. Persist separate per-file patches for ledger vs delta so neither overwrites the other
    const ledgerPerFile = ledgerPerFilePatches ?? perFilePatches ?? new Map<string, string>();
    const deltaPerFile = deltaPerFilePatches ?? perFilePatches ?? new Map<string, string>();

    for (const [targetPath, patchText] of ledgerPerFile.entries()) {
      const fileHash = shortHash(targetPath, 8);
      const fileDiffPath = path.join(ledgerFilesDir, `${fileHash}.diff`);
      writeAtomicText(fileDiffPath, patchText);
      const fileRecallId = this.makeLedgerFileRecallId(taskId, revision, targetPath);
      this.registerRecallEntry({
        recall_id: fileRecallId,
        task_id: taskId,
        revision,
        kind: 'file_diff',
        target_path: targetPath,
        file_path_rel: path.relative(this.dataDir, fileDiffPath),
        byte_length: Buffer.byteLength(patchText, 'utf8'),
        created_at: now,
      });
    }

    for (const [targetPath, patchText] of deltaPerFile.entries()) {
      const fileHash = shortHash(targetPath, 8);
      const fileDiffPath = path.join(deltaFilesDir, `${fileHash}.diff`);
      writeAtomicText(fileDiffPath, patchText);
      const fileRecallId = this.makeDeltaFileRecallId(taskId, revision, targetPath);
      this.registerRecallEntry({
        recall_id: fileRecallId,
        task_id: taskId,
        revision,
        kind: 'file_diff',
        target_path: targetPath,
        file_path_rel: path.relative(this.dataDir, fileDiffPath),
        byte_length: Buffer.byteLength(patchText, 'utf8'),
        created_at: now,
      });
    }

    const attachFileRecall = <T extends { path: string; recall_id?: string }>(
      items: T[],
      patches: Map<string, string>,
      makeId: (p: string) => string
    ): T[] =>
      items.map((entry) =>
        patches.has(entry.path) ? { ...entry, recall_id: makeId(entry.path) } : entry
      );

    const redactedBlockers = metadataWithoutRecall.unverified_blockers.map((b) => ({
      claim: redactSensitiveText(b.claim),
      evidence: b.evidence ? redactSensitiveText(b.evidence) : null,
    }));
    const redactedCounterEvidence = metadataWithoutRecall.unverified_counter_evidence.map((c) => ({
      claim: redactSensitiveText(c.claim),
      evidence: c.evidence ? redactSensitiveText(c.evidence) : null,
    }));

    const reportPayload = {
      source: 'executor_model_self_report',
      verified: false,
      reported_status: metadataWithoutRecall.reported_status,
      blockers: redactedBlockers,
      counter_evidence: redactedCounterEvidence,
    };
    const reportJsonText = `${JSON.stringify(reportPayload, null, 2)}\n`;
    const reportFile = path.join(revDir, 'report.json');
    writeAtomicText(reportFile, reportJsonText);
    const reportRecallId = `rc_${taskId}_r${revision}_report`;
    this.registerRecallEntry({
      recall_id: reportRecallId,
      task_id: taskId,
      revision,
      kind: 'report',
      file_path_rel: path.relative(this.dataDir, reportFile),
      byte_length: Buffer.byteLength(reportJsonText, 'utf8'),
      created_at: now,
    });

    const fullMeta: RevisionMetadata = {
      ...metadataWithoutRecall,
      unverified_blockers: redactedBlockers,
      unverified_counter_evidence: redactedCounterEvidence,
      native_events: metadataWithoutRecall.native_events.map((e) => ({
        source: e.source,
        message: redactSensitiveText(e.message),
      })),
      ledger_files: attachFileRecall(metadataWithoutRecall.ledger_files, ledgerPerFile, (p) =>
        this.makeLedgerFileRecallId(taskId, revision, p)
      ),
      delta_files: attachFileRecall(metadataWithoutRecall.delta_files, deltaPerFile, (p) =>
        this.makeDeltaFileRecallId(taskId, revision, p)
      ),
      recall_ids: {
        diff: diffRecallId,
        ledger_diff: ledgerRecallId,
        logs: logsRecallId,
        raw_trace: traceRecallId,
        report: reportRecallId,
        ...(execDiffRecallId ? { exec_diff: execDiffRecallId } : {}),
        ...(verifySideEffectRecallId ? { verify_side_effect_diff: verifySideEffectRecallId } : {}),
      },
    };

    // Publish meta.json last so revision becomes visible only once all immutable artifacts exist
    writeAtomicJson(this.revisionMetaFile(taskId, revision), fullMeta);
    return fullMeta;
  }

  ensureRangeDiffRecall(params: {
    taskId: string;
    fromRevision: number;
    toRevision: number;
    fullPatch: string;
    perFilePatches: Map<string, string>;
  }): { rangeDiffRecallId: string; fileRecallIds: Map<string, string> } {
    const { taskId, fromRevision, toRevision, fullPatch, perFilePatches } = params;
    const rangeDiffRecallId = `rc_${taskId}_r${fromRevision}_to_r${toRevision}_diff`;
    const fileRecallIds = new Map<string, string>();
    for (const targetPath of perFilePatches.keys()) {
      fileRecallIds.set(
        targetPath,
        this.makeRangeFileRecallId(taskId, fromRevision, toRevision, targetPath)
      );
    }

    const rangeRegFile = path.join(this.recallRegistryDir(), `${rangeDiffRecallId}.json`);
    const allFilesRegistered = Array.from(fileRecallIds.values()).every((id) =>
      fs.existsSync(path.join(this.recallRegistryDir(), `${id}.json`))
    );
    if (fs.existsSync(rangeRegFile) && allFilesRegistered) {
      return { rangeDiffRecallId, fileRecallIds };
    }

    const now = new Date().toISOString();
    const rangeDir = path.join(
      this.taskDir(taskId),
      'ranges',
      `r${fromRevision}-to-r${toRevision}`
    );
    const rangeFilesDir = path.join(rangeDir, 'files');
    fs.mkdirSync(rangeFilesDir, { recursive: true });

    const rangeDiffFile = path.join(rangeDir, 'range.diff');
    writeAtomicText(rangeDiffFile, fullPatch);
    this.registerRecallEntry({
      recall_id: rangeDiffRecallId,
      task_id: taskId,
      revision: toRevision,
      kind: 'range_diff',
      file_path_rel: path.relative(this.dataDir, rangeDiffFile),
      byte_length: Buffer.byteLength(fullPatch, 'utf8'),
      created_at: now,
    });

    for (const [targetPath, patchText] of perFilePatches.entries()) {
      const fileHash = shortHash(targetPath, 8);
      const fileDiffPath = path.join(rangeFilesDir, `${fileHash}.diff`);
      writeAtomicText(fileDiffPath, patchText);
      const id = fileRecallIds.get(targetPath)!;
      this.registerRecallEntry({
        recall_id: id,
        task_id: taskId,
        revision: toRevision,
        kind: 'file_diff',
        target_path: targetPath,
        file_path_rel: path.relative(this.dataDir, fileDiffPath),
        byte_length: Buffer.byteLength(patchText, 'utf8'),
        created_at: now,
      });
    }

    return { rangeDiffRecallId, fileRecallIds };
  }

  readRevisionMetadata(taskId: string, revision: number): RevisionMetadata {
    const file = this.revisionMetaFile(taskId, revision);
    if (!fs.existsSync(file)) {
      throw new Error(`Revision ${revision} not found for task "${taskId}".`);
    }
    return readJsonWithRetry<RevisionMetadata>(file);
  }

  readRevisionDiffText(taskId: string, revision: number, cumulative: boolean): string {
    const file = path.join(
      this.revisionDir(taskId, revision),
      cumulative ? 'ledger.diff' : 'delta.diff'
    );
    if (!fs.existsSync(file)) return '';
    return fs.readFileSync(file, 'utf8');
  }

  readPerFileDiffsMap(
    taskId: string,
    revision: number,
    paths: string[],
    scope: 'delta' | 'ledger' = 'delta'
  ): Map<string, string> {
    const out = new Map<string, string>();
    const revDir = this.revisionDir(taskId, revision);
    const scopedDir = path.join(revDir, 'files', scope);
    const legacyDir = path.join(revDir, 'files');
    for (const p of paths) {
      const hashName = `${shortHash(p, 8)}.diff`;
      const scopedFile = path.join(scopedDir, hashName);
      const legacyFile = path.join(legacyDir, hashName);
      if (fs.existsSync(scopedFile)) {
        out.set(p, fs.readFileSync(scopedFile, 'utf8'));
      } else if (fs.existsSync(legacyFile)) {
        out.set(p, fs.readFileSync(legacyFile, 'utf8'));
      }
    }
    return out;
  }

  paginateRecall(recallId: string, cursor?: string, maxContentBytes = 6144): PaginatedRecallSlice {
    if (!/^[A-Za-z0-9_-]{4,128}$/.test(recallId)) {
      throw new Error(`Invalid recall_id format: "${recallId}".`);
    }
    const regFile = path.join(this.recallRegistryDir(), `${recallId}.json`);
    if (!fs.existsSync(regFile)) {
      throw new Error(`Unknown recall_id: "${recallId}".`);
    }
    const entry = readJsonWithRetry<RecallIndexEntry>(regFile);
    const absPath = path.resolve(this.dataDir, entry.file_path_rel);
    const relCheck = path.relative(this.dataDir, absPath);
    if (relCheck.startsWith('..') || path.isAbsolute(relCheck)) {
      throw new Error(`Security violation: recall artifact outside data directory.`);
    }
    if (!fs.existsSync(absPath)) {
      throw new Error(`Recall artifact missing on disk for "${recallId}".`);
    }

    let startOffset = 0;
    if (cursor && cursor.trim() !== '' && cursor !== '0') {
      const m = /^(?:offset:)?(\d+)$/.exec(cursor.trim());
      if (!m) {
        throw new Error(`Invalid pagination cursor "${cursor}". Expected "offset:<bytes>".`);
      }
      startOffset = Number(m[1]);
    }

    const buf = fs.readFileSync(absPath);
    const safeBudget = Math.max(32, Math.min(maxContentBytes, 28 * 1024));
    const { text, nextOffset } = sliceUtf8BufferAligned(buf, startOffset, safeBudget);
    const hasMore = nextOffset < buf.length;

    return {
      recall_id: entry.recall_id,
      task_id: entry.task_id,
      revision: entry.revision,
      kind: entry.kind,
      ...(entry.target_path ? { target_path: entry.target_path } : {}),
      content: text,
      cursor: `offset:${startOffset}`,
      next_cursor: hasMore ? `offset:${nextOffset}` : null,
      has_more: hasMore,
      total_bytes: buf.length,
      returned_bytes: Buffer.byteLength(text, 'utf8'),
    };
  }
}
