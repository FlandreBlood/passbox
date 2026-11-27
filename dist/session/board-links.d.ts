export interface BoardFileLink {
    uri: string;
    uri_with_line?: string;
    rel_path: string;
    line?: number;
    end_line?: number;
    column?: number;
}
export declare function resolveWorkspaceFileLink(workspace: string, filename: string): BoardFileLink | null;
export declare function resolveEvidenceFileLink(workspace: string, evidence: string | null | undefined): BoardFileLink | null;
