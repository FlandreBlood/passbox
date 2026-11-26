import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  captureWorkspaceSnapshot,
  computeTreeDiff,
  computeUnexpectedFiles,
  prepareManagedWorktree,
  resolveGitWorkspaceRoot,
  splitUnifiedDiffByFile,
} from '../src/evidence/index.js';
import { parseExecutorReportText } from '../src/adapters/index.js';
import { createTempGitRepo, execGit, hashFileSha256 } from './helpers/temp-git.js';

describe('M5 Evidence Collector — Git Snapshot & Tree Diff Invariants', () => {
  it('preserves dirty .git/index byte-for-byte while isolating baseline vs post-run edits', () => {
    const { repoDir, cleanup } = createTempGitRepo();
    try {
      // Set up pre-existing staged, unstaged, untracked, and gitignored files BEFORE task starts
      fs.writeFileSync(path.join(repoDir, 'staged-pre.txt'), 'staged before task\n', 'utf8');
      execGit(repoDir, ['add', 'staged-pre.txt']);

      fs.writeFileSync(
        path.join(repoDir, 'src-app.ts'),
        'export function greet(name: string): string {\n  // pre-existing unstaged edit\n  return `Hello, ${name}`;\n}\n',
        'utf8'
      );
      fs.writeFileSync(path.join(repoDir, 'untracked-pre.txt'), 'untracked before task\n', 'utf8');
      fs.writeFileSync(path.join(repoDir, '.env.secret'), 'OPENAI_API_KEY=sk-secret1234567890123456\n', 'utf8');

      const gitIndexPath = path.join(repoDir, '.git', 'index');
      const indexHashBefore = hashFileSha256(gitIndexPath);
      const porcelainBefore = execGit(repoDir, ['status', '--porcelain=v1', '-uall']);

      // Capture T0 baseline snapshot
      const t0 = captureWorkspaceSnapshot(repoDir);
      assert.equal(hashFileSha256(gitIndexPath), indexHashBefore, '.git/index must not be mutated by T0 snapshot');
      assert.equal(execGit(repoDir, ['status', '--porcelain=v1', '-uall']), porcelainBefore);

      // Simulate Codex making new changes (modifying src-app.ts, adding new-feature.ts, deleting untracked-pre.txt)
      fs.writeFileSync(
        path.join(repoDir, 'src-app.ts'),
        'export function greet(name: string): string {\n  // pre-existing unstaged edit\n  if (name === null) return "guest";\n  try {\n    return `Hi, ${name ?? "friend"}`;\n  } catch {\n    return "fallback";\n  }\n}\n',
        'utf8'
      );
      fs.writeFileSync(path.join(repoDir, 'new-feature.ts'), 'export const VERSION = 2;\n', 'utf8');
      fs.rmSync(path.join(repoDir, 'untracked-pre.txt'));

      const t1 = captureWorkspaceSnapshot(repoDir);
      assert.equal(hashFileSha256(gitIndexPath), indexHashBefore, '.git/index must still match pre-T0 hash');

      const diff = computeTreeDiff(repoDir, t0.tree_oid, t1.tree_oid);
      const changedPaths = diff.files.map((f) => f.path).sort();

      // staged-pre.txt (unchanged since T0) and .env.secret (gitignored) must NOT appear in T0->T1 diff!
      assert.deepEqual(changedPaths, ['new-feature.ts', 'src-app.ts', 'untracked-pre.txt']);
      assert.equal(diff.files.find((f) => f.path === 'new-feature.ts')?.status, 'A');
      assert.equal(diff.files.find((f) => f.path === 'src-app.ts')?.status, 'M');
      assert.equal(diff.files.find((f) => f.path === 'untracked-pre.txt')?.status, 'D');

      // Observational signals: unexpected_files & guard_signals
      const unexpected = computeUnexpectedFiles(changedPaths, ['src-app.ts']);
      assert.deepEqual(unexpected, ['new-feature.ts', 'untracked-pre.txt']);
      assert.ok(diff.guardSignals.try_catch_added >= 1);
      assert.ok(diff.guardSignals.nullish_or_type_guards_added >= 1);
      assert.ok(diff.guardSignals.fallback_defaults_added >= 1);
      assert.ok(diff.guardSignals.early_guard_returns_added >= 1);
    } finally {
      cleanup();
    }
  });

  it('supports unborn-HEAD repositories (git init with zero commits)', () => {
    const { repoDir, cleanup } = createTempGitRepo({ unbornHead: true });
    try {
      const t0 = captureWorkspaceSnapshot(repoDir);
      assert.equal(t0.head_oid, null);

      fs.writeFileSync(path.join(repoDir, 'added.txt'), 'hello unborn\n', 'utf8');
      const t1 = captureWorkspaceSnapshot(repoDir);

      const diff = computeTreeDiff(repoDir, t0.tree_oid, t1.tree_oid);
      assert.deepEqual(diff.files.map((f) => f.path), ['added.txt']);
      assert.equal(diff.totals.insertions, 1);
    } finally {
      cleanup();
    }
  });

  it('supports Worktree Mode without dropping uncommitted baseline edits or mutating primary workspace', () => {
    const { repoDir, cleanup } = createTempGitRepo();
    const wtRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'passbox-wt-'));
    try {
      // Dirty uncommitted changes in user's primary workspace
      fs.writeFileSync(path.join(repoDir, 'dirty-local.txt'), 'must not be lost in worktree\n', 'utf8');
      const t0 = captureWorkspaceSnapshot(repoDir);

      const wtPath = prepareManagedWorktree(repoDir, 'task_wt_1', wtRoot, t0);
      assert.equal(
        fs.readFileSync(path.join(wtPath, 'dirty-local.txt'), 'utf8'),
        'must not be lost in worktree\n'
      );

      // Edit inside worktree must not affect primary workspace
      fs.writeFileSync(path.join(wtPath, 'only-in-wt.ts'), 'export const WT = true;\n', 'utf8');
      assert.equal(fs.existsSync(path.join(repoDir, 'only-in-wt.ts')), false);

      const wtSnap = captureWorkspaceSnapshot(wtPath);
      const wtDiff = computeTreeDiff(wtPath, t0.tree_oid, wtSnap.tree_oid);
      assert.deepEqual(wtDiff.files.map((f) => f.path), ['only-in-wt.ts']);
    } finally {
      cleanup();
      fs.rmSync(wtRoot, { recursive: true, force: true });
    }
  });

  it('handles paths with spaces without trailing tab corruption and ignores fake +++ b/ lines inside diff hunks', () => {
    const { repoDir, cleanup } = createTempGitRepo();
    try {
      const t0 = captureWorkspaceSnapshot(repoDir);

      fs.writeFileSync(
        path.join(repoDir, 'monthly report.ts'),
        'export const report = "+++ b/fake-in-hunk.ts";\n',
        'utf8'
      );
      fs.mkdirSync(path.join(repoDir, 'dir with space'), { recursive: true });
      fs.writeFileSync(
        path.join(repoDir, 'dir with space', 'sub file.ts'),
        'export const sub = 1;\n',
        'utf8'
      );

      const t1 = captureWorkspaceSnapshot(repoDir);
      const diff = computeTreeDiff(repoDir, t0.tree_oid, t1.tree_oid);
      const paths = diff.files.map((f) => f.path).sort();

      assert.deepEqual(paths, ['dir with space/sub file.ts', 'monthly report.ts']);
      assert.ok(diff.perFilePatches.has('monthly report.ts'));
      assert.ok(diff.perFilePatches.has('dir with space/sub file.ts'));
      assert.ok(!diff.perFilePatches.has('fake-in-hunk.ts'));
      assert.ok(diff.previewEligiblePatch.includes('monthly report.ts'));
      assert.ok(diff.previewEligiblePatch.includes('dir with space/sub file.ts'));

      const parsed = splitUnifiedDiffByFile(diff.fullPatch);
      assert.deepEqual(Array.from(parsed.keys()).sort(), [
        'dir with space/sub file.ts',
        'monthly report.ts',
      ]);
    } finally {
      cleanup();
    }
  });

  it('throws when git diff fails instead of silently returning zero changes, and rejects relative workspace paths', () => {
    assert.throws(() => resolveGitWorkspaceRoot('.'), /absolute path/i);
    assert.throws(() => resolveGitWorkspaceRoot('relative/repo'), /absolute path/i);

    const { repoDir, cleanup } = createTempGitRepo();
    try {
      const t0 = captureWorkspaceSnapshot(repoDir);
      assert.throws(
        () => computeTreeDiff(repoDir, t0.tree_oid, 'f'.repeat(40)),
        /git diff.*failed/i
      );

      // Moving .git away must also fail explicitly rather than returning 0 files
      fs.renameSync(path.join(repoDir, '.git'), path.join(repoDir, '.git-backup'));
      try {
        assert.throws(
          () => computeTreeDiff(repoDir, t0.tree_oid, 'e'.repeat(40)),
          /git diff.*failed/i
        );
      } finally {
        fs.renameSync(path.join(repoDir, '.git-backup'), path.join(repoDir, '.git'));
      }
    } finally {
      cleanup();
    }
  });

  it('tolerates omitted optional arrays in executor report while rejecting explicit null fields', () => {
    const omitted = parseExecutorReportText(JSON.stringify({ status: 'completed' }));
    assert.equal(omitted.reportedStatus, 'completed');
    assert.deepEqual(omitted.report, {
      status: 'completed',
      blockers: [],
      counter_evidence: [],
    });

    const nullBlockers = parseExecutorReportText(
      JSON.stringify({ status: 'completed', blockers: null, counter_evidence: [] })
    );
    assert.equal(nullBlockers.reportedStatus, 'invalid');
    assert.equal(nullBlockers.report, null);
  });
});
