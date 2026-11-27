import type { ArchiveStore } from '../observability/archive-store.js';
import type { ExecutorFinalReport, RevisionMetadata, RunRecord } from '../types.js';
import { type BoardFileLink } from './board-links.js';
export interface LiveEntry {
    key: string;
    kind: string;
    status: 'running' | 'completed' | 'failed' | 'declined' | 'canceled' | 'info';
    at: string | null;
    updated_at?: string;
    duration_ms?: number;
    text: string;
    command?: string;
    exit_code?: number | null;
    aggregated_output?: string;
    arguments?: string;
    result?: string;
    error?: string;
    files?: Array<{
        path: string;
        file_link: BoardFileLink | null;
    }>;
    report?: ExecutorFinalReport & {
        verified: false;
    };
    truncated?: boolean;
}
export interface LiveStream {
    trust: 'untrusted_artifact_data';
    entries: LiveEntry[];
    omitted_count: number;
    truncated: boolean;
    stderr_tail: string;
    stderr_truncated: boolean;
}
export declare function readLiveStream(archive: ArchiveStore, taskId: string, workspace: string, run: Pick<RunRecord, 'run_id' | 'published_revision' | 'started_at' | 'finished_at'>, meta?: RevisionMetadata): LiveStream;
