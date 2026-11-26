import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_BUDGETS,
  EvidenceFirewall,
  mcpWireSerializedBytes,
  utf8ByteLength,
} from '../src/firewall/index.js';
import { ArchiveStore } from '../src/observability/index.js';
import { createTempGitRepo } from './helpers/temp-git.js';
import { captureWorkspaceSnapshot, computeTreeDiff } from '../src/evidence/index.js';
import type { ChangedFileEntry, TaskRecord } from '../src/types.js';

describe('M4 Evidence Firewall & M6 Recall Pagination Budgets', () => {
  it('enforces strict byte caps on status (<=512B), collect (<=32KiB & <=300 lines), errors, and multi-byte UTF-8 recall pages (<=8KiB)', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'passbox-fw-'));
    try {
      const archive = new ArchiveStore(dataDir);
      const firewall = new EvidenceFirewall(archive);

      const taskId = 'pb_test_budget_01';
      const hugeLine = 'const text = "跨模型上下文隔离与确定性证据回传验证 🚀 "; // padding line\n';
      const bigFilePatch =
        `diff --git a/src/big.ts b/src/big.ts\n--- a/src/big.ts\n+++ b/src/big.ts\n@@ -1,1 +1,450 @@\n` +
        Array.from({ length: 450 }, (_, idx) => `+${idx}: ${hugeLine.trim()}`).join('\n') +
        '\n';
      const lockfilePatch =
        `diff --git a/package-lock.json b/package-lock.json\n--- a/package-lock.json\n+++ b/package-lock.json\n@@ -1 +1,200 @@\n` +
        Array.from({ length: 200 }, (_, i) => `+"dep_${i}": "1.0.0",`).join('\n') +
        '\n';

      const perFile = new Map<string, string>([
        ['src/big.ts', bigFilePatch],
        ['package-lock.json', lockfilePatch],
      ]);

      const files: ChangedFileEntry[] = [
        {
          path: 'src/big.ts',
          status: 'M',
          insertions: 450,
          deletions: 0,
          binary: false,
          omitted_from_preview: false,
        },
        {
          path: 'package-lock.json',
          status: 'M',
          insertions: 200,
          deletions: 0,
          binary: false,
          omitted_from_preview: true,
          omit_reason: 'lockfile',
        },
      ];

      const published = archive.publishImmutableRevision({
        taskId,
        runId: 'run_1',
        revision: 1,
        ledgerPatch: `${bigFilePatch}${lockfilePatch}`,
        deltaPatch: `${bigFilePatch}${lockfilePatch}`,
        perFilePatches: perFile,
        verifyLogs: `OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwx123456\n${'log line\n'.repeat(2000)}`,
        rawTraceSourceFile: '',
        metadataWithoutRecall: {
          task_id: taskId,
          run_id: 'run_1',
          revision: 1,
          published_at: new Date().toISOString(),
          from_tree_oid: '0'.repeat(40),
          exec_tree_oid: '1'.repeat(40),
          final_tree_oid: '1'.repeat(40),
          baseline_tree_oid: '0'.repeat(40),
          execution_status: 'succeeded',
          reported_status: 'completed',
          verification_status: 'passed',
          ledger_totals: { files_changed: 2, insertions: 650, deletions: 0, net_lines: 650 },
          ledger_files: files,
          delta_totals: { files_changed: 2, insertions: 650, deletions: 0, net_lines: 650 },
          delta_files: files,
          unexpected_files: [],
          guard_signals: {
            try_catch_added: 0,
            nullish_or_type_guards_added: 0,
            fallback_defaults_added: 0,
            early_guard_returns_added: 0,
            note: 'heuristic',
          },
          external_drift_files: [],
          verify_side_effect_files: [],
          verify_results: [
            {
              index: 0,
              argv: ['npm', 'test'],
              exit_code: 0,
              timed_out: false,
              duration_ms: 420,
              output_excerpt: 'ok',
            },
          ],
          unverified_blockers: [],
          unverified_counter_evidence: [{ claim: 'Upstream allows empty string', evidence: 'src/a.ts:12' }],
          native_events: [],
          snapshot_notes: [],
          usage: { input_tokens: 100, output_tokens: 20 },
        },
      });

      const fakeTask: TaskRecord = {
        task_id: taskId,
        objective: 'Test budgets',
        requested_workspace: '/repo',
        repo_root: '/repo',
        execution_workspace: '/repo',
        workspace_mode: 'snapshot',
        contract: {},
        state: 'idle',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        baseline_snapshot: {
          tree_oid: '0'.repeat(40),
          head_oid: '0'.repeat(40),
          captured_at: new Date().toISOString(),
          dirty_entry_count: 0,
          scope_notes: [],
        },
        latest_tree_oid: '1'.repeat(40),
        current_revision: 1,
        active_run_id: null,
        active_thread_id: 'thread_1',
        archived_thread_ids: [],
        queued_steer: null,
        runs: [],
      };

      // 1. Status must be <= 512 bytes
      const statusJson = firewall.formatStatusResponse(fakeTask, null);
      assert.ok(
        utf8ByteLength(statusJson) <= DEFAULT_BUDGETS.statusBytes,
        `status bytes ${utf8ByteLength(statusJson)} exceeded 512`
      );

      // 2. Collect must omit lockfile from preview, cap lines <= 300 & bytes <= 32 KiB
      const collectJson = firewall.formatCollectResponse({
        task: fakeTask,
        activeRun: null,
        waitedMs: 5,
      });
      assert.ok(utf8ByteLength(collectJson) <= DEFAULT_BUDGETS.hardMaxBytes);
      const collectObj = JSON.parse(collectJson) as Record<string, any>;
      assert.equal(collectObj.artifacts.trust, 'untrusted_artifact_data');
      assert.equal(collectObj.unverified_claims.verified, false);
      assert.ok(!collectObj.artifacts.diff_preview.includes('package-lock.json'));
      assert.equal(collectObj.artifacts.omitted_files.length, 1);
      assert.equal(collectObj.artifacts.omitted_files[0].omit_reason, 'lockfile');
      assert.ok(collectObj.artifacts.diff_lines_shown <= DEFAULT_BUDGETS.previewLines);
      assert.equal(collectObj.artifacts.diff_truncated, true);

      // 3. Repeat collect with since_revision=1 returns unchanged=true without repeating diff
      const unchangedJson = firewall.formatCollectResponse({
        task: fakeTask,
        activeRun: null,
        sinceRevision: 1,
        waitedMs: 1,
      });
      const unchangedObj = JSON.parse(unchangedJson) as Record<string, any>;
      assert.equal(unchangedObj.unchanged, true);
      assert.equal(unchangedObj.artifacts, undefined);

      // 4. Paginate big diff across multiple <=8KiB pages and verify lossless UTF-8 reconstruction
      let cursor: string | undefined;
      let reassembled = '';
      let pages = 0;
      for (;;) {
        const pageJson = firewall.formatRecallResponse(published.recall_ids.diff, cursor);
        const byteSize = utf8ByteLength(pageJson);
        assert.ok(
          byteSize <= DEFAULT_BUDGETS.recallBytes,
          `recall page size ${byteSize} exceeded 8192 bytes`
        );
        const pageObj = JSON.parse(pageJson) as Record<string, any>;
        assert.ok(!pageObj.content.includes('\uFFFD'), 'UTF-8 multi-byte character must never be split');
        reassembled += pageObj.content;
        pages++;
        if (!pageObj.has_more) break;
        cursor = pageObj.next_cursor;
      }
      assert.ok(pages >= 4, 'Expected multiple pages for large diff');
      assert.equal(reassembled, `${bigFilePatch}${lockfilePatch}`);

      // 5. Recall logs must have redacted the secret API key
      const logsPage = JSON.parse(
        firewall.formatRecallResponse(published.recall_ids.logs)
      ) as Record<string, any>;
      assert.ok(!logsPage.content.includes('sk-abcdefghijklmnopqrstuvwx123456'));
      assert.ok(logsPage.content.includes('[REDACTED'));

      // 6. Oversized error is bounded and redacted
      const hugeErr = new Error(
        `Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.secretpayload ` + 'X'.repeat(50000)
      );
      const errFormatted = firewall.formatErrorResponse(taskId, hugeErr, 512);
      assert.ok(mcpWireSerializedBytes(errFormatted.text) <= 512);
      assert.ok(!errFormatted.text.includes('secretpayload'));
      const errObj = JSON.parse(errFormatted.text) as Record<string, any>;
      assert.ok(typeof errObj.diagnostic_recall_id === 'string');
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('enforces wire-exact JSON-RPC byte caps (<=8KiB default, <=32KiB max) on dense JSONL raw_trace and separates ledger vs delta per-file recall', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'passbox-wire-fw-'));
    try {
      const archive = new ArchiveStore(dataDir);
      const firewall = new EvidenceFirewall(archive);
      const taskId = 'pb_wire_budget_01';

      // Create dense JSONL trace full of quotes/backslashes that expand heavily under JSON-RPC double serialization
      const rawTraceFile = path.join(dataDir, 'source-trace.jsonl');
      const traceLines = Array.from({ length: 420 }, (_, i) =>
        JSON.stringify({
          type: 'item.completed',
          seq: i,
          item: {
            type: 'command_execution',
            command: `node -e "console.log(\\"line_${i}\\\\n\\\\t\\\\\\"${'x'.repeat(40)}\\")"`,
          },
        })
      ).join('\n');
      fs.writeFileSync(rawTraceFile, `${traceLines}\n`, 'utf8');

      const ledgerPatch =
        'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1,2 @@\n+const ledger = 1;\n+const delta = 2;\n';
      const deltaPatch =
        'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,2 +1,2 @@\n const ledger = 1;\n+const delta = 2;\n';

      const published = archive.publishImmutableRevision({
        taskId,
        runId: 'run_1',
        revision: 1,
        ledgerPatch,
        deltaPatch,
        ledgerPerFilePatches: new Map([['a.ts', ledgerPatch]]),
        deltaPerFilePatches: new Map([['a.ts', deltaPatch]]),
        verifyLogs: 'ok',
        rawTraceSourceFile: rawTraceFile,
        metadataWithoutRecall: {
          task_id: taskId,
          run_id: 'run_1',
          revision: 1,
          published_at: new Date().toISOString(),
          from_tree_oid: '0'.repeat(40),
          exec_tree_oid: '1'.repeat(40),
          final_tree_oid: '1'.repeat(40),
          baseline_tree_oid: '0'.repeat(40),
          execution_status: 'succeeded',
          reported_status: 'completed',
          verification_status: 'passed',
          ledger_totals: { files_changed: 1, insertions: 2, deletions: 0, net_lines: 2 },
          ledger_files: [
            {
              path: 'a.ts',
              status: 'M',
              insertions: 2,
              deletions: 0,
              binary: false,
              omitted_from_preview: false,
            },
          ],
          delta_totals: { files_changed: 1, insertions: 1, deletions: 0, net_lines: 1 },
          delta_files: [
            {
              path: 'a.ts',
              status: 'M',
              insertions: 1,
              deletions: 0,
              binary: false,
              omitted_from_preview: false,
            },
          ],
          unexpected_files: [],
          guard_signals: {
            try_catch_added: 0,
            nullish_or_type_guards_added: 0,
            fallback_defaults_added: 0,
            early_guard_returns_added: 0,
            note: 'heuristic',
          },
          external_drift_files: [],
          verify_side_effect_files: [],
          verify_results: [],
          unverified_blockers: [],
          unverified_counter_evidence: [],
          native_events: [],
          snapshot_notes: [],
          usage: null,
        },
      });

      // Verify ledger vs delta file recall IDs are distinct and return their respective patches
      assert.notEqual(published.ledger_files[0].recall_id, published.delta_files[0].recall_id);
      const ledgerFileRecall = JSON.parse(
        firewall.formatRecallResponse(published.ledger_files[0].recall_id!)
      );
      const deltaFileRecall = JSON.parse(
        firewall.formatRecallResponse(published.delta_files[0].recall_id!)
      );
      assert.equal(ledgerFileRecall.content, ledgerPatch);
      assert.equal(deltaFileRecall.content, deltaPatch);

      // Default 8 KiB recall over dense JSONL must fit <= 8192 bytes INCLUDING full JSON-RPC envelope
      let cursor: string | undefined;
      let reassembled = '';
      for (;;) {
        const innerText = firewall.formatRecallResponse(published.recall_ids.raw_trace, cursor);
        const realRpcFrame = `${JSON.stringify({
          jsonrpc: '2.0',
          id: 42,
          result: { content: [{ type: 'text', text: innerText }] },
        })}\n`;
        assert.ok(
          utf8ByteLength(realRpcFrame) <= DEFAULT_BUDGETS.recallBytes,
          `real RPC frame ${utf8ByteLength(realRpcFrame)} exceeded 8192 bytes`
        );
        const page = JSON.parse(innerText);
        reassembled += page.content;
        if (!page.has_more) break;
        cursor = page.next_cursor;
      }
      assert.equal(reassembled, `${traceLines}\n`);

      // Max 32 KiB recall over dense JSONL must fit <= 32768 bytes INCLUDING full JSON-RPC envelope
      const maxInner = firewall.formatRecallResponse(published.recall_ids.raw_trace, undefined, 32768);
      const maxRpcFrame = `${JSON.stringify({
        jsonrpc: '2.0',
        id: 43,
        result: { content: [{ type: 'text', text: maxInner }] },
      })}\n`;
      assert.ok(
        utf8ByteLength(maxRpcFrame) <= DEFAULT_BUDGETS.hardMaxBytes,
        `max recall RPC frame ${utf8ByteLength(maxRpcFrame)} exceeded 32768 bytes`
      );
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('falls back to archived per-revision deltas for r1->r3 when .git is unavailable instead of returning zero changes', () => {
    const { repoDir, cleanup } = createTempGitRepo();
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'passbox-fallback-fw-'));
    try {
      const archive = new ArchiveStore(dataDir);
      const firewall = new EvidenceFirewall(archive);
      const taskId = 'pb_fallback_r1_r3';

      const t0 = captureWorkspaceSnapshot(repoDir);
      fs.writeFileSync(path.join(repoDir, 'f1.ts'), 'export const a = 1;\n', 'utf8');
      const t1 = captureWorkspaceSnapshot(repoDir);
      fs.writeFileSync(path.join(repoDir, 'f2.ts'), 'export const b = 2;\n', 'utf8');
      const t2 = captureWorkspaceSnapshot(repoDir);
      fs.writeFileSync(path.join(repoDir, 'f3.ts'), 'export const c = 3;\n', 'utf8');
      const t3 = captureWorkspaceSnapshot(repoDir);

      const snapshots = [t0, t1, t2, t3];
      for (let rev = 1; rev <= 3; rev++) {
        const ledger = computeTreeDiff(repoDir, t0.tree_oid, snapshots[rev].tree_oid);
        const delta = computeTreeDiff(repoDir, snapshots[rev - 1].tree_oid, snapshots[rev].tree_oid);
        archive.publishImmutableRevision({
          taskId,
          runId: `run_${rev}`,
          revision: rev,
          ledgerPatch: ledger.fullPatch,
          deltaPatch: delta.fullPatch,
          ledgerPerFilePatches: ledger.perFilePatches,
          deltaPerFilePatches: delta.perFilePatches,
          verifyLogs: 'ok',
          rawTraceSourceFile: '',
          metadataWithoutRecall: {
            task_id: taskId,
            run_id: `run_${rev}`,
            revision: rev,
            published_at: new Date().toISOString(),
            from_tree_oid: snapshots[rev - 1].tree_oid,
            exec_tree_oid: snapshots[rev].tree_oid,
            final_tree_oid: snapshots[rev].tree_oid,
            baseline_tree_oid: t0.tree_oid,
            execution_status: 'succeeded',
            reported_status: 'completed',
            verification_status: 'passed',
            ledger_totals: ledger.totals,
            ledger_files: ledger.files,
            delta_totals: delta.totals,
            delta_files: delta.files,
            unexpected_files: [],
            guard_signals: delta.guardSignals,
            external_drift_files: [],
            verify_side_effect_files: [],
            verify_results: [],
            unverified_blockers: [],
            unverified_counter_evidence: [],
            native_events: [],
            snapshot_notes: [],
            usage: null,
          },
        });
      }

      // Move .git away so live computeTreeDiff fails and archived fallback must activate
      fs.renameSync(path.join(repoDir, '.git'), path.join(repoDir, '.git-moved'));
      try {
        const task: TaskRecord = {
          task_id: taskId,
          objective: 'Fallback check',
          requested_workspace: repoDir,
          repo_root: repoDir,
          execution_workspace: repoDir,
          workspace_mode: 'snapshot',
          contract: {},
          state: 'idle',
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          baseline_snapshot: t0,
          latest_tree_oid: t3.tree_oid,
          current_revision: 3,
          active_run_id: null,
          active_thread_id: 'thread_1',
          archived_thread_ids: [],
          queued_steer: null,
          queued_steers: [],
          runs: [],
        };

        const out = JSON.parse(
          firewall.formatCollectResponse({ task, activeRun: null, sinceRevision: 1, waitedMs: 1 })
        );
        const paths = out.observations.delta_since_revision.files.map((f: any) => f.path).sort();
        assert.deepEqual(paths, ['f2.ts', 'f3.ts']);
        assert.ok(out.artifacts.diff_preview.includes('f2.ts'));
        assert.ok(out.artifacts.diff_preview.includes('f3.ts'));
        assert.ok(
          out.observations.snapshot_notes.some((n: string) => /fell back to archived/i.test(n))
        );
      } finally {
        fs.renameSync(path.join(repoDir, '.git-moved'), path.join(repoDir, '.git'));
      }
    } finally {
      cleanup();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
