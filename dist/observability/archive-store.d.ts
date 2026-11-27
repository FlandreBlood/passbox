import type { CoordinatorActivityRecord, RecallIndexEntry, RevisionMetadata, RunActivityItem } from '../types.js';
export declare function resolvePluginDataDir(explicitDataDir?: string): string;
export declare function shortHash(input: string, len?: number): string;
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
export declare function sliceUtf8BufferAligned(buf: Buffer, startByte: number, maxBytes: number): {
    text: string;
    nextOffset: number;
};
export declare class ArchiveStore {
    readonly dataDir: string;
    constructor(explicitDataDir?: string);
    tasksRootDir(): string;
    worktreesRootDir(): string;
    recallRegistryDir(): string;
    globalLockDir(): string;
    taskDir(taskId: string): string;
    taskLockDir(taskId: string): string;
    taskStateFile(taskId: string): string;
    coordinatorStateFile(taskId: string): string;
    readCoordinatorActivity(taskId: string): CoordinatorActivityRecord | null;
    writeCoordinatorActivity(taskId: string, update: Partial<CoordinatorActivityRecord> & Pick<CoordinatorActivityRecord, 'last_action'>): CoordinatorActivityRecord;
    listTaskIds(): string[];
    revisionDir(taskId: string, revision: number): string;
    revisionMetaFile(taskId: string, revision: number): string;
    runPaths(taskId: string, runId: string): RunArtifactPaths;
    appendRunActivity(taskId: string, runId: string, item: RunActivityItem): void;
    readRunActivities(taskId: string, runId: string): RunActivityItem[];
    private registerRecallEntry;
    makeDeltaFileRecallId(taskId: string, revision: number, filePath: string): string;
    makeLedgerFileRecallId(taskId: string, revision: number, filePath: string): string;
    makeRangeFileRecallId(taskId: string, fromRevision: number, toRevision: number, filePath: string): string;
    makeFileRecallId(taskId: string, revision: number, filePath: string): string;
    archiveDiagnosticError(taskId: string | null, rawErrorText: string): string;
    publishImmutableRevision(input: PublishRevisionInput): RevisionMetadata;
    ensureRangeDiffRecall(params: {
        taskId: string;
        fromRevision: number;
        toRevision: number;
        fullPatch: string;
        perFilePatches: Map<string, string>;
    }): {
        rangeDiffRecallId: string;
        fileRecallIds: Map<string, string>;
    };
    readRevisionMetadata(taskId: string, revision: number): RevisionMetadata;
    readRevisionDiffText(taskId: string, revision: number, cumulative: boolean): string;
    readPerFileDiffsMap(taskId: string, revision: number, paths: string[], scope?: 'delta' | 'ledger'): Map<string, string>;
    paginateRecall(recallId: string, cursor?: string, maxContentBytes?: number): PaginatedRecallSlice;
}
