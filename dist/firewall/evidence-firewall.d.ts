import type { BudgetOptions, RunRecord, TaskRecord } from '../types.js';
import type { ArchiveStore } from '../observability/archive-store.js';
import type { PassboxBoardSnapshot } from '../session/session-manager.js';
export declare class EvidenceFirewall {
    private readonly archive;
    constructor(archive: ArchiveStore);
    /**
     * Formats `passbox_status` response strictly <= 512 UTF-8 bytes.
     */
    formatStatusResponse(task: TaskRecord, activeRun: RunRecord | null): string;
    /**
     * Formats fleet-level `passbox_status({})` model-facing text strictly <= 512 UTF-8 bytes.
     */
    formatFleetStatusResponse(board: PassboxBoardSnapshot): string;
    /**
     * Bounds MCP App `structuredContent` safely below 240 KiB (well within Antigravity's 1 MiB trajectory cap).
     */
    boundBoardStructuredContent(board: PassboxBoardSnapshot): Record<string, unknown>;
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
    }): string;
    private buildObservationsObject;
    private buildFilteredPreviewPatch;
    /**
     * Paginates an immutable Recall artifact while guaranteeing the final wire-serialized
     * MCP JSON-RPC response never exceeds `limitBytes` (default 8 KiB, max 32 KiB) and
     * advances `next_cursor` by the exact UTF-8 byte count actually returned.
     */
    formatRecallResponse(recallId: string, cursor?: string, limitBytes?: number): string;
    /**
     * Formats simple control responses (`delegate`, `steer`, `cancel`) within budget.
     */
    formatControlResponse(payload: Record<string, unknown>, maxBytes?: number): string;
    /**
     * Formats any tool/validation/runtime error within budget while archiving full diagnostic text.
     */
    formatErrorResponse(taskId: string | null, error: unknown, maxBytes?: number): {
        text: string;
        isError: true;
    };
}
