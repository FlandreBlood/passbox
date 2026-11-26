import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
const STRIPPED_GIT_ENV_KEYS = [
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_INDEX_FILE',
    'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES',
    'GIT_COMMON_DIR',
    'GIT_PREFIX',
];
export function buildCleanGitEnv(extra) {
    const env = { ...process.env };
    for (const key of STRIPPED_GIT_ENV_KEYS) {
        delete env[key];
    }
    env.GIT_TERMINAL_PROMPT = '0';
    env.GIT_OPTIONAL_LOCKS = '0';
    env.LC_ALL = 'C';
    if (extra) {
        Object.assign(env, extra);
    }
    return env;
}
export function runGitSync(cwd, args, extraEnv, timeoutMs = 30000) {
    const res = spawnSync('git', ['-c', 'core.quotePath=false', ...args], {
        cwd,
        env: buildCleanGitEnv(extraEnv),
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        timeout: timeoutMs,
        windowsHide: true,
    });
    if (res.error) {
        throw new Error(`Failed executing git ${args[0] ?? ''}: ${res.error.message}`);
    }
    return {
        status: res.status ?? 1,
        stdout: res.stdout ?? '',
        stderr: res.stderr ?? '',
    };
}
export function resolveGitWorkspaceRoot(workspace) {
    if (!workspace || typeof workspace !== 'string' || !workspace.trim()) {
        throw new Error('`workspace` parameter is required and must be an absolute path to a Git repository.');
    }
    const trimmed = workspace.trim();
    if (!path.isAbsolute(trimmed)) {
        throw new Error(`Workspace "${workspace}" must be an absolute path to the target Git repository (relative paths are rejected).`);
    }
    const resolved = path.resolve(trimmed);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
        throw new Error(`Workspace directory does not exist: ${resolved}`);
    }
    const top = runGitSync(resolved, ['rev-parse', '--show-toplevel']);
    if (top.status !== 0 || !top.stdout.trim()) {
        throw new Error(`Workspace "${resolved}" is not a Git worktree. Passbox Snapshot Mode requires a Git repository.`);
    }
    return path.resolve(top.stdout.trim());
}
function resolveRealGitIndexPath(repoRoot) {
    const res = runGitSync(repoRoot, ['rev-parse', '--git-path', 'index']);
    if (res.status !== 0 || !res.stdout.trim())
        return null;
    const raw = res.stdout.trim();
    return path.isAbsolute(raw) ? raw : path.resolve(repoRoot, raw);
}
/**
 * Captures a full tree snapshot (including staged, unstaged, and non-ignored untracked files)
 * using an isolated temporary GIT_INDEX_FILE without modifying the user's real Git index or working tree.
 */
export function captureWorkspaceSnapshot(repoRoot) {
    const scopeNotes = [
        'gitignored files and submodule internals are excluded by default',
    ];
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'passbox-idx-'));
    const tempIndex = path.join(tmpDir, `index.${randomUUID()}`);
    try {
        const realIndex = resolveRealGitIndexPath(repoRoot);
        if (realIndex && fs.existsSync(realIndex)) {
            fs.copyFileSync(realIndex, tempIndex);
        }
        const headRes = runGitSync(repoRoot, ['rev-parse', '--verify', 'HEAD']);
        const headOid = headRes.status === 0 && headRes.stdout.trim() ? headRes.stdout.trim() : null;
        const statusRes = runGitSync(repoRoot, ['status', '--porcelain=v1', '-uall']);
        const dirtyLines = statusRes.stdout
            .split(/\r?\n/)
            .map((l) => l.trimEnd())
            .filter(Boolean);
        const addRes = runGitSync(repoRoot, ['add', '-A', '--', '.'], {
            GIT_INDEX_FILE: tempIndex,
        });
        if (addRes.status !== 0) {
            throw new Error(`Snapshot git add -A failed (exit ${addRes.status}): ${addRes.stderr.trim()}`);
        }
        if (addRes.stderr.trim()) {
            const cleanNote = addRes.stderr
                .trim()
                .split(/\r?\n/)
                .slice(0, 2)
                .join('; ');
            if (cleanNote)
                scopeNotes.push(`git-add: ${cleanNote}`);
        }
        const treeRes = runGitSync(repoRoot, ['write-tree'], {
            GIT_INDEX_FILE: tempIndex,
        });
        if (treeRes.status !== 0 || !treeRes.stdout.trim()) {
            throw new Error(`Snapshot git write-tree failed (exit ${treeRes.status}): ${treeRes.stderr.trim()}`);
        }
        return {
            tree_oid: treeRes.stdout.trim(),
            head_oid: headOid,
            captured_at: new Date().toISOString(),
            dirty_entry_count: dirtyLines.length,
            scope_notes: scopeNotes,
        };
    }
    finally {
        try {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
        catch { }
    }
}
/**
 * Creates an isolated Git worktree for `workspace_mode: "worktree"` and materializes
 * `baselineTreeOid` into it so uncommitted source edits are preserved without touching
 * the user's primary workspace.
 */
export function prepareManagedWorktree(repoRoot, taskId, worktreesRootDir, baselineSnapshot) {
    const wtPath = path.join(worktreesRootDir, taskId);
    fs.rmSync(wtPath, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(wtPath), { recursive: true });
    if (baselineSnapshot.head_oid) {
        const addWt = runGitSync(repoRoot, [
            'worktree',
            'add',
            '--detach',
            wtPath,
            baselineSnapshot.head_oid,
        ]);
        if (addWt.status !== 0) {
            throw new Error(`Failed creating managed git worktree: ${addWt.stderr.trim()}`);
        }
    }
    else {
        const addOrphan = runGitSync(repoRoot, ['worktree', 'add', '--orphan', '-B', `passbox-${taskId}`, wtPath]);
        if (addOrphan.status !== 0) {
            throw new Error(`Failed creating orphan git worktree: ${addOrphan.stderr.trim()}`);
        }
    }
    // Materialize exact baseline tree (including staged, unstaged, and untracked files from source)
    const readTree = runGitSync(wtPath, [
        '-c',
        'core.autocrlf=false',
        'read-tree',
        '--reset',
        '-u',
        baselineSnapshot.tree_oid,
    ]);
    if (readTree.status !== 0) {
        throw new Error(`Failed materializing baseline tree into worktree: ${readTree.stderr.trim()}`);
    }
    return wtPath;
}
