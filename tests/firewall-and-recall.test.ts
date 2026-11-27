import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_BUDGETS,
  boundActivitySummary,
  sanitizeActivityItem,
  EvidenceFirewall,
  mcpWireSerializedBytes,
  utf8ByteLength,
} from '../src/firewall/index.js';
import { ArchiveStore } from '../src/observability/index.js';
import { createTempGitRepo } from './helpers/temp-git.js';
import { captureWorkspaceSnapshot, computeTreeDiff } from '../src/evidence/index.js';
import type { ChangedFileEntry, TaskRecord } from '../src/types.js';
import type { PassboxBoardSnapshot } from '../src/session/index.js';

describe('M4 Evidence Firewall & M6 Recall Pagination Budgets', () => {
  it('redacts activity labels, keeps the newest whole events and accumulates omitted counts', () => {
    const at = '2026-11-27T01:02:03.000Z';
    const activity = { at, kind: 'command', status: 'started' } as const;
    const labels = [
      'export MY_API_KEY=test-api MY_SECRET_KEY="test secret" PASSWORD=test\\ value AUTH_TOKEN=auth-24',
      'curl --token=tok-24 --api-key=key-24 -H "Authorization: Basic dXNlcjpwYXNz"',
      'curl https://test-user:test-pass@example.invalid/path',
      'verify[1]: tool "--password=test secret suffix"',
      'echo \n\t multiline',
    ];
    for (const label of labels) {
      const clean = sanitizeActivityItem({ ...activity, label, args: ['ignore'], output: 'ignore' })!;
      assert.deepEqual(Object.keys(clean).sort(), ['at', 'kind', 'label', 'status']);
      assert.doesNotMatch(clean.label, /test[- ]|auth-24|tok-24|key-24|dXNlcjpwYXNz|[\r\n\t]/);
      assert.deepEqual(sanitizeActivityItem(clean), clean);
    }
    const long = sanitizeActivityItem({ ...activity, label: '中😀'.repeat(100) })!;
    assert.ok(utf8ByteLength(long.label) <= 120);
    assert.doesNotMatch(long.label, /\uFFFD/);

    const items = Array.from({ length: 15 }, (_, i) => ({
      ...activity,
      at: new Date(Date.parse(at) + i * 1000).toISOString(),
      label: i + ' ' + '"😀中\\'.repeat(35),
      extra: 'restricted',
    }));
    const summary = boundActivitySummary([...items].reverse());
    assert.ok(summary.omitted_count > 0);
    assert.ok(utf8ByteLength(JSON.stringify(summary)) <= DEFAULT_BUDGETS.summaryBytes);
    assert.deepEqual(summary.activities, items.slice(summary.omitted_count).map(sanitizeActivityItem));
    const oneMore = {
      activities: [sanitizeActivityItem(items[summary.omitted_count - 1]), ...summary.activities],
      omitted_count: summary.omitted_count - 1,
    };
    assert.ok(utf8ByteLength(JSON.stringify(oneMore)) > DEFAULT_BUDGETS.summaryBytes);

    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'passbox-activities-'));
    try {
      const archive = new ArchiveStore(dataDir);
      archive.appendRunActivity('pb_test', 'run_1', items[1]);
      archive.appendRunActivity('pb_test', 'run_1', items[0]);
      const { activitiesFile } = archive.runPaths('pb_test', 'run_1');
      fs.appendFileSync(activitiesFile, '{"incomplete":');
      const first = items.slice(0, 2).map(sanitizeActivityItem);
      assert.deepEqual(archive.readRunActivities('pb_test', 'run_1'), first);
      archive.appendRunActivity('pb_test', 'run_1', items[2]);
      assert.deepEqual(archive.readRunActivities('pb_test', 'run_1'), items.slice(0, 3).map(sanitizeActivityItem));

      const oversized = {
        tasks: [{
          runs: [{
            activities: summary.activities,
            activities_omitted_count: summary.omitted_count,
            delta_files: [],
            unverified_blockers: Array.from({ length: 10 }, () => ({ claim: 'x'.repeat(30_000) })),
            unverified_counter_evidence: [],
          }],
        }],
      } as unknown as PassboxBoardSnapshot;
      const firewall = new EvidenceFirewall(archive);
      const clamped = firewall.boundBoardStructuredContent(oversized);
      assert.equal(clamped.board_clamped, true);
      const run = (clamped as unknown as PassboxBoardSnapshot).tasks[0].runs[0];
      const clampedSummary = { activities: run.activities, omitted_count: run.activities_omitted_count };
      assert.ok(utf8ByteLength(JSON.stringify(clampedSummary)) <= 512);
      assert.ok(run.activities_omitted_count > summary.omitted_count);
      assert.deepEqual(run.activities, items.slice(run.activities_omitted_count).map(sanitizeActivityItem));
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('bounds escaped detail payloads and retains the selected run and newest process entries', () => {
    const archiveDir = fs.mkdtempSync(path.join(os.tmpdir(), 'passbox-board-budget-'));
    try {
      const firewall = new EvidenceFirewall(new ArchiveStore(archiveDir));
      const entries = Array.from({ length: 120 }, (_, i) => ({
        key: 'event-' + i, kind: 'agent_message', status: 'completed' as const, at: null, text: '中'.repeat(200),
      }));
      const board: PassboxBoardSnapshot = {
        generated_at: new Date().toISOString(), focus_task_id: 'pb_1', tasks: [],
        default_codex_model: { resolved_model: null, model_source: 'codex_cli_default', reasoning_effort: null },
        summary: { total_tasks: 1, running_tasks: 0, idle_tasks: 1, failed_or_interrupted_tasks: 0 },
        task_detail: {
          task_id: 'pb_1', title: 'Task', objective_full: '\0'.repeat(29000), objective_truncated: false,
          contract_summary: { workspace_mode: 'snapshot' }, selected_run_id: 'run_1',
          runs_prompts: [{ run_id: 'run_1', sequence: 1, mode: 'initial', instruction_full: 'guidance', instruction_truncated: false }],
          rendered_prompt: '"\\'.repeat(12000), rendered_prompt_truncated: false,
          selected_run_live: { trust: 'untrusted_artifact_data', entries, omitted_count: 20,
            truncated: true, stderr_tail: 'diagnostic', stderr_truncated: false },
        },
      };
      const clamped = firewall.boundBoardStructuredContent(board) as unknown as PassboxBoardSnapshot;
      assert.ok(Buffer.byteLength(JSON.stringify(clamped)) <= 240 * 1024);
      assert.ok(clamped.task_detail?.rendered_prompt_truncated);
      const stream = clamped.task_detail.selected_run_live!;
      assert.ok(stream.truncated && stream.omitted_count > 20);
      assert.deepEqual(stream.entries, entries.slice(stream.omitted_count - 20));
      assert.equal(stream.entries.at(-1)?.key, 'event-119');
      assert.equal(board.task_detail!.rendered_prompt.length, 24000);
      assert.equal(entries.length, 120);
      board.task_detail!.contract_summary.acceptance = ['😀'.repeat(125000)];
      const extreme = firewall.boundBoardStructuredContent(board) as unknown as PassboxBoardSnapshot;
      assert.ok(Buffer.byteLength(JSON.stringify(extreme)) <= 240 * 1024);
      assert.ok(extreme.task_detail?.contract_truncated);
      assert.equal(extreme.task_detail.selected_run_id, 'run_1');
    } finally {
      fs.rmSync(archiveDir, { recursive: true, force: true });
    }
  });

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

  it('allocates adaptive unverified_claims budget for zero-diff reviews and exposes redacted report recall_id', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'passbox-report-recall-'));
    try {
      const archive = new ArchiveStore(dataDir);
      const firewall = new EvidenceFirewall(archive);

      // Case A: zero-diff read-only review with 12 rich Chinese blockers + 5 counter_evidence (~7.5 KiB total)
      const blockersA = Array.from({ length: 12 }, (_, idx) => ({
        claim: `P1-${idx + 1}｜当上游并发写入账本时未确认终态即返回成功，导致状态机与磁盘记录不一致：${'细节说明'.repeat(28)}`,
        evidence: `apps/workbench/src/pims-native.ts:${100 + idx * 10}-${110 + idx * 10}`,
      }));
      const counterA = Array.from({ length: 5 }, (_, idx) => ({
        claim: `已核实行为 ${idx + 1}：上游校验路径在进入 worker 前已完成参数归一化与路径白名单检查。`,
        evidence: `apps/dsh/src/pims-jobs.ts:${40 + idx * 5}`,
      }));

      const pubA = archive.publishImmutableRevision({
        taskId: 'pb_review_a',
        runId: 'run_1',
        revision: 1,
        ledgerPatch: '',
        deltaPatch: '',
        verifyLogs: '',
        rawTraceSourceFile: '',
        metadataWithoutRecall: {
          task_id: 'pb_review_a',
          run_id: 'run_1',
          revision: 1,
          published_at: new Date().toISOString(),
          from_tree_oid: '0'.repeat(40),
          exec_tree_oid: '0'.repeat(40),
          final_tree_oid: '0'.repeat(40),
          baseline_tree_oid: '0'.repeat(40),
          execution_status: 'succeeded',
          reported_status: 'completed',
          verification_status: 'not_run',
          ledger_totals: { files_changed: 0, insertions: 0, deletions: 0, net_lines: 0 },
          ledger_files: [],
          delta_totals: { files_changed: 0, insertions: 0, deletions: 0, net_lines: 0 },
          delta_files: [],
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
          unverified_blockers: blockersA,
          unverified_counter_evidence: counterA,
          native_events: [],
          snapshot_notes: [],
          usage: null,
        },
      });

      assert.ok(pubA.recall_ids.report);
      const taskA: TaskRecord = {
        task_id: 'pb_review_a',
        objective: 'Read-only review',
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
        latest_tree_oid: '0'.repeat(40),
        current_revision: 1,
        active_run_id: null,
        active_thread_id: 'thread_a',
        archived_thread_ids: [],
        queued_steer: null,
        runs: [],
      };

      const collectARaw = firewall.formatCollectResponse({ task: taskA, activeRun: null, waitedMs: 1 });
      assert.ok(mcpWireSerializedBytes(collectARaw) <= DEFAULT_BUDGETS.hardMaxBytes);
      const collectA = JSON.parse(collectARaw);
      assert.equal(collectA.unverified_claims.verified, false);
      assert.equal(collectA.unverified_claims.claims_truncated, false);
      assert.equal(collectA.unverified_claims.blockers.length, 12);
      assert.equal(collectA.unverified_claims.counter_evidence.length, 5);
      assert.equal(collectA.unverified_claims.blockers[0].claim, blockersA[0].claim);
      assert.equal(collectA.artifacts.recall_ids.report, pubA.recall_ids.report);

      const reportPageA = JSON.parse(firewall.formatRecallResponse(pubA.recall_ids.report!));
      assert.equal(reportPageA.trust, 'untrusted_artifact_data');
      assert.equal(reportPageA.kind, 'report');

      // Case B: oversized report (> 22 KiB) with secret tokens must truncate claims safely and expose report_recall_id
      const blockersB = Array.from({ length: 24 }, (_, idx) => ({
        claim: `Finding ${idx + 1} with Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.secretpayload_${idx}: ${'detail '.repeat(140)}`,
        evidence: `src/module_${idx}.ts:${idx + 10}`,
      }));
      const pubB = archive.publishImmutableRevision({
        taskId: 'pb_review_b',
        runId: 'run_1',
        revision: 1,
        ledgerPatch: '',
        deltaPatch: '',
        verifyLogs: '',
        rawTraceSourceFile: '',
        metadataWithoutRecall: {
          task_id: 'pb_review_b',
          run_id: 'run_1',
          revision: 1,
          published_at: new Date().toISOString(),
          from_tree_oid: '0'.repeat(40),
          exec_tree_oid: '0'.repeat(40),
          final_tree_oid: '0'.repeat(40),
          baseline_tree_oid: '0'.repeat(40),
          execution_status: 'succeeded',
          reported_status: 'partial',
          verification_status: 'not_run',
          ledger_totals: { files_changed: 0, insertions: 0, deletions: 0, net_lines: 0 },
          ledger_files: [],
          delta_totals: { files_changed: 0, insertions: 0, deletions: 0, net_lines: 0 },
          delta_files: [],
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
          unverified_blockers: blockersB,
          unverified_counter_evidence: [{ claim: 'Counter note sk-testsecretkey1234567890abcdef', evidence: 'src/ok.ts:1' }],
          native_events: [],
          snapshot_notes: [],
          usage: null,
        },
      });
      const taskB: TaskRecord = { ...taskA, task_id: 'pb_review_b' };
      const collectBRaw = firewall.formatCollectResponse({ task: taskB, activeRun: null, waitedMs: 1 });
      assert.ok(mcpWireSerializedBytes(collectBRaw) <= DEFAULT_BUDGETS.hardMaxBytes);
      const collectB = JSON.parse(collectBRaw);
      assert.equal(collectB.unverified_claims.claims_truncated, true);
      assert.equal(collectB.unverified_claims.blockers_total, 24);
      assert.equal(collectB.unverified_claims.report_recall_id, pubB.recall_ids.report);
      assert.ok(!collectBRaw.includes('secretpayload'));

      let rCursor: string | undefined;
      let fullReportText = '';
      for (;;) {
        const pageJson = firewall.formatRecallResponse(pubB.recall_ids.report!, rCursor);
        assert.ok(mcpWireSerializedBytes(pageJson) <= DEFAULT_BUDGETS.recallBytes);
        const page = JSON.parse(pageJson);
        fullReportText += page.content;
        if (!page.has_more) break;
        rCursor = page.next_cursor;
      }
      assert.ok(!fullReportText.includes('secretpayload'));
      assert.ok(!fullReportText.includes('sk-testsecretkey1234567890abcdef'));
      const parsedFull = JSON.parse(fullReportText);
      assert.equal(parsedFull.verified, false);
      assert.equal(parsedFull.blockers.length, 24);
      assert.equal(parsedFull.counter_evidence.length, 1);
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
