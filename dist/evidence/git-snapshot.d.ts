import type { SnapshotCapture } from '../types.js';
export declare function buildCleanGitEnv(extra?: Record<string, string>): NodeJS.ProcessEnv;
export interface GitExecResult {
    status: number;
    stdout: string;
    stderr: string;
}
export declare function runGitSync(cwd: string, args: string[], extraEnv?: Record<string, string>, timeoutMs?: number): GitExecResult;
export declare function resolveGitWorkspaceRoot(workspace: string): string;
/**
 * Captures a full tree snapshot (including staged, unstaged, and non-ignored untracked files)
 * using an isolated temporary GIT_INDEX_FILE without modifying the user's real Git index or working tree.
 */
export declare function captureWorkspaceSnapshot(repoRoot: string): SnapshotCapture;
/**
 * Creates an isolated Git worktree for `workspace_mode: "worktree"` and materializes
 * `baselineTreeOid` into it so uncommitted source edits are preserved without touching
 * the user's primary workspace.
 */
export declare function prepareManagedWorktree(repoRoot: string, taskId: string, worktreesRootDir: string, baselineSnapshot: SnapshotCapture): string;
