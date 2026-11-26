import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isPidAlive } from '../src/observability/index.js';
import type { FakeCodexScenarioFile } from './helpers/fake-codex.js';
import { createTempGitRepo } from './helpers/temp-git.js';

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(THIS_DIR, '..', '..');
const FAKE_CODEX_JS = path.join(THIS_DIR, 'helpers', 'fake-codex.js');
const MCP_SERVER_JS = path.join(REPO_ROOT, 'dist', 'interface', 'mcp-server.js');

class StdioMcpTestClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (val: any) => void; reject: (err: Error) => void }
  >();
  private buf = '';

  constructor(envOverrides: Record<string, string>) {
    this.child = spawn(process.execPath, [MCP_SERVER_JS], {
      cwd: REPO_ROOT,
      env: { ...process.env, ...envOverrides },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => {
      this.buf += chunk;
      let idx: number;
      while ((idx = this.buf.indexOf('\n')) !== -1) {
        const line = this.buf.slice(0, idx).trim();
        this.buf = this.buf.slice(idx + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        const waiter = this.pending.get(msg.id);
        if (waiter) {
          this.pending.delete(msg.id);
          if (msg.error) waiter.reject(new Error(msg.error.message));
          else waiter.resolve(msg.result);
        }
      }
    });
  }

  request(method: string, params: Record<string, unknown> = {}): { id: number; promise: Promise<any> } {
    const id = this.nextId++;
    const promise = new Promise<any>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return { id, promise };
  }

  notify(method: string, params: Record<string, unknown> = {}): void {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  async callToolParsed(name: string, args: Record<string, unknown>): Promise<{ isError: boolean; data: any; rawText: string }> {
    const { promise } = this.request('tools/call', { name, arguments: args });
    const res = await promise;
    const rawText = res.content?.[0]?.text ?? '{}';
    return {
      isError: Boolean(res.isError),
      data: JSON.parse(rawText),
      rawText,
    };
  }

  async callToolWithFrameBytes(
    name: string,
    args: Record<string, unknown>
  ): Promise<{ isError: boolean; data: any; rawText: string; frameBytes: number }> {
    const { id, promise } = this.request('tools/call', { name, arguments: args });
    const res = await promise;
    const rawText = res.content?.[0]?.text ?? '{}';
    const frame = `${JSON.stringify({ jsonrpc: '2.0', id, result: res })}\n`;
    return {
      isError: Boolean(res.isError),
      data: JSON.parse(rawText),
      rawText,
      frameBytes: Buffer.byteLength(frame, 'utf8'),
    };
  }

  async close(): Promise<void> {
    this.child.stdin.end();
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        try {
          this.child.kill();
        } catch {}
        resolve();
      }, 1500);
      this.child.once('close', () => {
        clearTimeout(t);
        resolve();
      });
    });
  }
}

function writeFakeScenario(stateDir: string, scenario: FakeCodexScenarioFile): void {
  fs.mkdirSync(stateDir, { recursive: true });
  fs.rmSync(path.join(stateDir, 'call-count.txt'), { force: true });
  fs.writeFileSync(path.join(stateDir, 'scenario.json'), JSON.stringify(scenario, null, 2), 'utf8');
}

describe('M1-M6 End-to-End MCP Orchestration & Session Lifecycle', () => {
  it('completes delegate -> collect -> steer (resume & reset_context) with incremental deltas, external drift, and verify side-effect separation', async () => {
    const { repoDir, cleanup } = createTempGitRepo();
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'passbox-e2e-data-'));
    const fakeStateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'passbox-fake-codex-'));

    writeFakeScenario(fakeStateDir, {
      steps: [
        // Run 1: edits src-app.ts, emits chatter (must NOT leak to collect), reports counter_evidence
        {
          emit_chatter: 'SECRET_NATURAL_LANGUAGE_NARRATIVE_THAT_MUST_NOT_APPEAR_IN_COLLECT',
          write_files: {
            'src-app.ts': 'export function greet(name: string): string {\n  return `Hi, ${name.trim()}`;\n}\n',
          },
          report: {
            status: 'partial',
            blockers: [],
            counter_evidence: [{ claim: 'Caller passes whitespace-only strings', evidence: 'src-app.ts:1' }],
          },
        },
        // Run 2 (steer resume): adds validator.ts
        {
          write_files: {
            'validator.ts': 'export function nonEmpty(s: string): boolean {\n  return s.trim().length > 0;\n}\n',
          },
          report: {
            status: 'completed',
            blockers: [],
            counter_evidence: [],
          },
        },
        // Run 3 (steer reset_context=true): updates README.md on a brand-new thread
        {
          write_files: {
            'README.md': '# Updated in clean context\n',
          },
          report: {
            status: 'completed',
            blockers: [],
            counter_evidence: [],
          },
        },
      ],
    });

    const client = new StdioMcpTestClient({
      PLUGIN_DATA: dataDir,
      PASSBOX_CODEX_BIN: FAKE_CODEX_JS,
      PASSBOX_FAKE_CODEX_STATE_DIR: fakeStateDir,
    });

    try {
      const initRes = await client.request('initialize', { protocolVersion: '2025-03-26' }).promise;
      assert.equal(initRes.serverInfo.name, 'passbox');

      const toolsRes = await client.request('tools/list').promise;
      assert.deepEqual(
        toolsRes.tools.map((t: any) => t.name),
        [
          'passbox_delegate',
          'passbox_collect',
          'passbox_steer',
          'passbox_status',
          'passbox_recall',
          'passbox_cancel',
        ]
      );

      // Verify command writes a coverage-artifact.txt to test verify_side_effect_files attribution!
      const delegated = await client.callToolParsed('passbox_delegate', {
        objective: 'Fix greeting whitespace handling',
        workspace: repoDir,
        contract: {
          expected_files: ['src-app.ts', 'validator.ts'],
          invariants: [{ claim: 'Input is non-empty', evidence: 'caller.ts:10' }],
          verify_commands: [
            {
              argv: [
                process.execPath,
                '-e',
                'require("node:fs").writeFileSync("verify-artifact.txt", "generated-by-test\\n")',
              ],
              timeout_seconds: 15,
            },
          ],
        },
      });
      assert.equal(delegated.isError, false);
      const taskId = delegated.data.task_id as string;
      assert.ok(taskId.startsWith('pb_'));

      // Collect revision 1
      const c1 = await client.callToolParsed('passbox_collect', {
        task_id: taskId,
        wait_seconds: 15,
      });
      assert.equal(c1.isError, false);
      assert.ok(!c1.rawText.includes('SECRET_NATURAL_LANGUAGE_NARRATIVE_THAT_MUST_NOT_APPEAR_IN_COLLECT'));
      assert.equal(c1.data.revision, 1);
      assert.equal(c1.data.execution_status, 'succeeded');
      assert.equal(c1.data.reported_status, 'partial');
      assert.equal(c1.data.verification_status, 'passed');
      assert.deepEqual(c1.data.observations.verify_side_effect_files, ['verify-artifact.txt']);
      assert.equal(c1.data.unverified_claims.counter_evidence[0].claim, 'Caller passes whitespace-only strings');

      // Repeat collect(since_revision: 1) -> unchanged: true
      const c1Repeat = await client.callToolParsed('passbox_collect', {
        task_id: taskId,
        since_revision: 1,
      });
      assert.equal(c1Repeat.data.unchanged, true);

      // Simulate external user edit between Run 1 and Run 2 -> must be disclosed in external_drift_files!
      fs.writeFileSync(path.join(repoDir, 'external-note.txt'), 'edited by user outside passbox\n', 'utf8');

      // Steer with session continuation (reset_context: false)
      const s2 = await client.callToolParsed('passbox_steer', {
        task_id: taskId,
        instruction: 'Add validator.ts for empty whitespace check',
        reset_context: false,
      });
      assert.equal(s2.data.action, 'started');
      assert.equal(s2.data.mode, 'resume');
      const firstThreadId = s2.data.thread_id;
      assert.ok(typeof firstThreadId === 'string' && firstThreadId.startsWith('thread_'));

      const c2 = await client.callToolParsed('passbox_collect', {
        task_id: taskId,
        since_revision: 1,
        wait_seconds: 15,
      });
      assert.equal(c2.data.revision, 2);
      assert.equal(c2.data.reported_status, 'completed');
      assert.deepEqual(c2.data.observations.external_drift_files, ['external-note.txt']);
      // Incremental delta (r1 -> r2) includes validator.ts and external-note.txt, NOT src-app.ts!
      const r2DeltaPaths = c2.data.observations.delta_since_revision.files.map((f: any) => f.path);
      assert.ok(r2DeltaPaths.includes('validator.ts'));
      assert.ok(!r2DeltaPaths.includes('src-app.ts'));
      // Cumulative ledger (T0 -> r2) still includes src-app.ts AND validator.ts!
      const r2LedgerPaths = c2.data.observations.ledger_t0_to_current.files.map((f: any) => f.path);
      assert.ok(r2LedgerPaths.includes('src-app.ts'));
      assert.ok(r2LedgerPaths.includes('validator.ts'));

      // Verify call-1 actually invoked `codex exec resume <firstThreadId>`
      const call1Log = JSON.parse(fs.readFileSync(path.join(fakeStateDir, 'call-1.json'), 'utf8'));
      assert.equal(call1Log.isResume, true);
      assert.equal(call1Log.threadId, firstThreadId);

      // Steer with reset_context: true -> must start a fresh session while keeping files & revisions!
      const s3 = await client.callToolParsed('passbox_steer', {
        task_id: taskId,
        instruction: 'Document behavior in README.md',
        reset_context: true,
      });
      assert.equal(s3.data.mode, 'reset_context');

      const c3 = await client.callToolParsed('passbox_collect', {
        task_id: taskId,
        since_revision: 2,
        wait_seconds: 15,
      });
      assert.equal(c3.data.revision, 3);
      assert.ok(fs.existsSync(path.join(repoDir, 'validator.ts')), 'reset_context must not revert workspace');

      const call2Log = JSON.parse(fs.readFileSync(path.join(fakeStateDir, 'call-2.json'), 'utf8'));
      assert.equal(call2Log.isResume, false);
      assert.notEqual(call2Log.threadId, firstThreadId);
    } finally {
      await client.close();
      cleanup();
      fs.rmSync(dataDir, { recursive: true, force: true });
      fs.rmSync(fakeStateDir, { recursive: true, force: true });
    }
  });

  it('handles transport cancellation safely, queues mid-run CLI steer, blocks concurrent same-workspace writers, and cancels with descendant cleanup', async () => {
    const { repoDir, cleanup } = createTempGitRepo();
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'passbox-async-data-'));
    const fakeStateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'passbox-async-fake-'));
    const sleeperPidFile = path.join(fakeStateDir, 'sleeper.pid');

    writeFakeScenario(fakeStateDir, {
      steps: [
        // Step 0: takes ~900ms, writes step1.txt
        {
          delay_ms: 900,
          write_files: { 'step1.txt': 'from run 1\n' },
          report: { status: 'completed' },
        },
        // Step 1 (auto-dispatched from queued mid-run steer!): writes step2.txt
        {
          delay_ms: 100,
          write_files: { 'step2.txt': 'from queued run 2\n' },
          report: { status: 'completed' },
        },
        // Step 2 (for cancel test): writes partial-before-cancel.txt, spawns grandchild sleeper, hangs 30s
        {
          hang_ms: 30000,
          spawn_sleeper_pid_file: sleeperPidFile,
          write_files: { 'partial-before-cancel.txt': 'must survive cancel\n' },
          report: { status: 'completed' },
        },
      ],
    });

    const client = new StdioMcpTestClient({
      PLUGIN_DATA: dataDir,
      PASSBOX_CODEX_BIN: FAKE_CODEX_JS,
      PASSBOX_FAKE_CODEX_STATE_DIR: fakeStateDir,
    });

    try {
      await client.request('initialize').promise;

      const d1 = await client.callToolParsed('passbox_delegate', {
        objective: 'Long running task',
        workspace: repoDir,
      });
      const taskId = d1.data.task_id as string;

      // 1. Concurrent same-workspace delegate in Snapshot Mode must be rejected!
      const concurrent = await client.callToolParsed('passbox_delegate', {
        objective: 'Conflicting writer',
        workspace: repoDir,
      });
      assert.equal(concurrent.isError, true);
      assert.match(concurrent.data.message, /already has an active running task/i);

      // 2. Start a long collect, then send MCP `notifications/cancelled` after 120ms ->
      //    collect returns promptly while the background run stays alive!
      const collectReq = client.request('tools/call', {
        name: 'passbox_collect',
        arguments: { task_id: taskId, wait_seconds: 30 },
      });
      setTimeout(() => {
        client.notify('notifications/cancelled', { requestId: collectReq.id });
      }, 120);
      const abortedCollectRaw = await collectReq.promise;
      const abortedCollect = JSON.parse(abortedCollectRaw.content[0].text);
      assert.equal(abortedCollect.state, 'running');

      // 3. Queue a mid-run steer while Run 1 is still executing -> must report action="queued"
      const midSteer = await client.callToolParsed('passbox_steer', {
        task_id: taskId,
        instruction: 'Follow up with step2.txt once Run 1 completes',
      });
      assert.equal(midSteer.data.action, 'queued');
      assert.equal(midSteer.data.realtime_steer, 'unsupported_in_cli_mode');

      // Wait for Run 1 AND auto-dispatched Run 2 to both complete (reaching revision 2)
      let latestCollect = await client.callToolParsed('passbox_collect', {
        task_id: taskId,
        since_revision: 0,
        wait_seconds: 15,
      });
      if (latestCollect.data.revision < 2) {
        latestCollect = await client.callToolParsed('passbox_collect', {
          task_id: taskId,
          since_revision: latestCollect.data.revision,
          wait_seconds: 15,
        });
      }
      assert.equal(latestCollect.data.revision, 2);
      assert.equal(fs.existsSync(path.join(repoDir, 'step1.txt')), true);
      assert.equal(fs.existsSync(path.join(repoDir, 'step2.txt')), true);

      // 4. Launch hanging Run 3 via steer, wait for grandchild PID, then cancel ->
      //    grandchild must die AND partial-before-cancel.txt must be collected in revision 3!
      await client.callToolParsed('passbox_steer', {
        task_id: taskId,
        instruction: 'Start long run that we will cancel',
      });

      const pidDeadline = Date.now() + 5000;
      while (!fs.existsSync(sleeperPidFile) && Date.now() < pidDeadline) {
        await new Promise((r) => setTimeout(r, 80));
      }
      assert.equal(fs.existsSync(sleeperPidFile), true, 'Expected fake-codex sleeper grandchild PID file');
      const sleeperPid = Number(fs.readFileSync(sleeperPidFile, 'utf8').trim());
      assert.equal(isPidAlive(sleeperPid), true);

      const cancelRes = await client.callToolParsed('passbox_cancel', { task_id: taskId });
      assert.equal(cancelRes.data.canceled, true);
      assert.equal(cancelRes.data.confirmed_exited, true);
      assert.equal(cancelRes.data.revision, 3);

      // Grandchild sleeper process must have been terminated with the process tree
      await new Promise((r) => setTimeout(r, 150));
      assert.equal(isPidAlive(sleeperPid), false, 'Grandchild process must be terminated on cancel');

      // Partial code written before cancel is preserved and visible via collect!
      const afterCancel = await client.callToolParsed('passbox_collect', {
        task_id: taskId,
        since_revision: 2,
      });
      assert.equal(afterCancel.data.execution_status, 'canceled');
      assert.ok(
        afterCancel.data.observations.delta_since_revision.files.some(
          (f: any) => f.path === 'partial-before-cancel.txt'
        )
      );
    } finally {
      await client.close();
      cleanup();
      fs.rmSync(dataDir, { recursive: true, force: true });
      fs.rmSync(fakeStateDir, { recursive: true, force: true });
    }
  });

  it('collects workspace evidence without auto-rerunning when Codex fails or omits/corrupts final report', async () => {
    const { repoDir, cleanup } = createTempGitRepo();
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'passbox-fail-data-'));
    const fakeStateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'passbox-fail-fake-'));

    writeFakeScenario(fakeStateDir, {
      steps: [
        {
          write_files: { 'salvaged-fix.ts': 'export const ok = 1;\n' },
          report_mode: 'invalid_json',
          exit_code: 1,
          stderr: 'Simulated Codex crash after writing salvaged-fix.ts',
        },
      ],
    });

    const client = new StdioMcpTestClient({
      PLUGIN_DATA: dataDir,
      PASSBOX_CODEX_BIN: FAKE_CODEX_JS,
      PASSBOX_FAKE_CODEX_STATE_DIR: fakeStateDir,
    });

    try {
      await client.request('initialize').promise;
      const d = await client.callToolParsed('passbox_delegate', {
        objective: 'Test crash resilience',
        workspace: repoDir,
      });
      const c = await client.callToolParsed('passbox_collect', {
        task_id: d.data.task_id,
        wait_seconds: 15,
      });
      assert.equal(c.data.revision, 1);
      assert.equal(c.data.execution_status, 'failed');
      assert.equal(c.data.reported_status, 'invalid');
      assert.ok(
        c.data.observations.ledger_t0_to_current.files.some(
          (f: any) => f.path === 'salvaged-fix.ts'
        )
      );
      const totalCalls = Number(fs.readFileSync(path.join(fakeStateDir, 'call-count.txt'), 'utf8').trim());
      assert.equal(totalCalls, 1, 'Must never automatically re-run failed Codex turns');
    } finally {
      await client.close();
      cleanup();
      fs.rmSync(dataDir, { recursive: true, force: true });
      fs.rmSync(fakeStateDir, { recursive: true, force: true });
    }
  });

  it('prevents concurrent same-workspace delegates via Promise.all, preserves r1->r3 range recall, and preserves FIFO dual steer queue', async () => {
    const { repoDir, cleanup } = createTempGitRepo();
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'passbox-race-data-'));
    const fakeStateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'passbox-race-fake-'));

    writeFakeScenario(fakeStateDir, {
      steps: [
        {
          delay_ms: 900,
          write_files: { 'a.ts': 'export const a = 1;\n' },
          report: { status: 'completed' },
        },
        {
          delay_ms: 100,
          write_files: { 'b.ts': 'export const b = 2;\n' },
          report: { status: 'completed' },
        },
        {
          delay_ms: 100,
          write_files: { 'c.ts': 'export const c = 3;\n', 'b.ts': 'export const b = 22;\n' },
          report: { status: 'completed' },
        },
      ],
    });

    const client = new StdioMcpTestClient({
      PLUGIN_DATA: dataDir,
      PASSBOX_CODEX_BIN: FAKE_CODEX_JS,
      PASSBOX_FAKE_CODEX_STATE_DIR: fakeStateDir,
    });

    try {
      await client.request('initialize').promise;

      // 1. Concurrent same-workspace delegates over the same MCP connection must allow ONLY ONE!
      const [d1, d2] = await Promise.all([
        client.callToolParsed('passbox_delegate', { objective: 'Writer 1', workspace: repoDir }),
        client.callToolParsed('passbox_delegate', { objective: 'Writer 2', workspace: repoDir }),
      ]);
      const successes = [d1, d2].filter((d) => !d.isError);
      const failures = [d1, d2].filter((d) => d.isError);
      assert.equal(successes.length, 1, 'Exactly one concurrent same-workspace delegate must succeed');
      assert.equal(failures.length, 1, 'Second concurrent same-workspace delegate must be rejected');
      assert.match(failures[0].data.message, /already has an active running task/i);

      const taskId = successes[0].data.task_id as string;

      // 2. Enqueue TWO mid-run steers -> both must execute in FIFO order (run_2 and run_3)
      const q1 = await client.callToolParsed('passbox_steer', {
        task_id: taskId,
        instruction: 'Queued instruction 1: create b.ts',
      });
      const q2 = await client.callToolParsed('passbox_steer', {
        task_id: taskId,
        instruction: 'Queued instruction 2: create c.ts',
      });
      assert.equal(q1.data.action, 'queued');
      assert.equal(q1.data.queue_position, 1);
      assert.equal(q2.data.action, 'queued');
      assert.equal(q2.data.queue_position, 2);

      let latestRev = 0;
      for (let i = 0; i < 6 && latestRev < 3; i++) {
        const c = await client.callToolParsed('passbox_collect', {
          task_id: taskId,
          since_revision: latestRev,
          wait_seconds: 15,
        });
        latestRev = c.data.revision;
      }
      assert.equal(latestRev, 3);
      assert.equal(fs.existsSync(path.join(repoDir, 'b.ts')), true);
      assert.equal(fs.existsSync(path.join(repoDir, 'c.ts')), true);

      // 3. Collect r1 -> r3 range and verify EVERY per-file recall_id exists and matches r1 -> r3!
      const r1ToR3 = await client.callToolParsed('passbox_collect', {
        task_id: taskId,
        since_revision: 1,
        wait_seconds: 0,
      });
      const rangeFiles = r1ToR3.data.observations.delta_since_revision.files as Array<any>;
      assert.deepEqual(rangeFiles.map((f) => f.path).sort(), ['b.ts', 'c.ts']);

      const bEntry = rangeFiles.find((f) => f.path === 'b.ts');
      assert.ok(bEntry?.recall_id, 'b.ts must have a range recall_id');
      const bRecall = await client.callToolParsed('passbox_recall', { recall_id: bEntry.recall_id });
      assert.equal(bRecall.isError, false);
      assert.ok(bRecall.data.content.includes('export const b = 22;'));
      assert.ok(
        !bRecall.data.content.includes('export const b = 2;\n'),
        'r1->r3 recall must reflect net r1->r3 diff, not r2->r3'
      );

      const cEntry = rangeFiles.find((f) => f.path === 'c.ts');
      const cRecall = await client.callToolParsed('passbox_recall', { recall_id: cEntry.recall_id });
      assert.equal(cRecall.isError, false);
      assert.ok(cRecall.data.content.includes('export const c = 3;'));
    } finally {
      await client.close();
      cleanup();
      fs.rmSync(dataDir, { recursive: true, force: true });
      fs.rmSync(fakeStateDir, { recursive: true, force: true });
    }
  });

  it('redacts raw run files, preserves pre-verify Codex edits when verify reverts them, cancels active verify_commands, and preserves >512KiB log tails & wire budgets', async () => {
    const { repoDir, cleanup } = createTempGitRepo();
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'passbox-sec-data-'));
    const fakeStateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'passbox-sec-fake-'));
    const secretKey = 'sk-testsecretkey1234567890abcdef';
    const bearerTok = 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.secretbody123';
    const markerFile = path.join(repoDir, 'verify-finished-after-cancel.txt');

    writeFakeScenario(fakeStateDir, {
      steps: [
        // Step 0: Codex edits src-app.ts AND leaks secrets in stdout/stderr/report; verify_commands reverts src-app.ts and emits >600KiB log
        {
          emit_chatter: `Chatter containing ${secretKey} and ${bearerTok}`,
          stderr: `Stderr leak ${secretKey}`,
          write_files: {
            'src-app.ts': 'export function greet(name: string): string {\n  return `CODEX_EDIT_${name}`;\n}\n',
          },
          report: {
            status: 'completed',
            blockers: [{ claim: `Auth failed with ${bearerTok}`, evidence: 'src-app.ts:1' }],
            counter_evidence: [],
          },
        },
        // Step 1: Codex completes immediately; verify_commands sleeps 2500ms before writing markerFile (to test cancel during verify!)
        {
          write_files: { 'src-app.ts': 'export function greet(name: string): string {\n  return `STEP2_${name}`;\n}\n' },
          report: { status: 'completed' },
        },
      ],
    });

    const client = new StdioMcpTestClient({
      PLUGIN_DATA: dataDir,
      PASSBOX_CODEX_BIN: FAKE_CODEX_JS,
      PASSBOX_FAKE_CODEX_STATE_DIR: fakeStateDir,
    });

    try {
      await client.request('initialize').promise;

      // Part A: Verify reverts Codex edit + emits >600KiB log with tail marker + secret redaction
      const bigLogAndRevertScript = [
        'const fs = require("node:fs");',
        'fs.writeFileSync("src-app.ts", "export function greet(name: string): string {\\n  return `Hello, ${name}`;\\n}\\n");',
        'const line = "VERBOSE_VERIFY_LOG_PADDING_" + "A".repeat(200) + "\\n";',
        'process.stdout.write(line.repeat(3200));',
        'process.stdout.write("FINAL_FAILURE_SUMMARY_MARKER\\n");',
      ].join(' ');

      const d1 = await client.callToolParsed('passbox_delegate', {
        objective: 'Modify src-app.ts with verify revert and huge logs',
        workspace: repoDir,
        contract: {
          verify_commands: [{ argv: [process.execPath, '-e', bigLogAndRevertScript], timeout_seconds: 30 }],
        },
      });
      const taskId = d1.data.task_id as string;

      const c1 = await client.callToolParsed('passbox_collect', { task_id: taskId, wait_seconds: 20 });
      assert.equal(c1.data.revision, 1);
      // Even though verify reverted src-app.ts, pre-verify Codex edit is preserved in exec_delta_before_verify & exec_diff recall!
      assert.ok(c1.data.observations.verify_side_effect_files.includes('src-app.ts'));
      assert.equal(c1.data.observations.exec_delta_before_verify.totals.files_changed, 1);
      assert.ok(c1.data.artifacts.recall_ids.exec_diff);
      assert.ok(c1.data.artifacts.recall_ids.verify_side_effect_diff);

      const execDiffPage = await client.callToolParsed('passbox_recall', {
        recall_id: c1.data.artifacts.recall_ids.exec_diff,
      });
      assert.ok(execDiffPage.data.content.includes('CODEX_EDIT_'));

      // Tail marker must be preserved in both output_excerpt AND paginated logs recall!
      assert.ok(c1.data.artifacts.verify_commands[0].output_excerpt.includes('FINAL_FAILURE_SUMMARY_MARKER'));
      let logCursor: string | undefined;
      let fullLogs = '';
      for (;;) {
        const lp = await client.callToolWithFrameBytes('passbox_recall', {
          recall_id: c1.data.artifacts.recall_ids.logs,
          cursor: logCursor,
          limit: 32768,
        });
        assert.ok(lp.frameBytes <= 32768, `frameBytes ${lp.frameBytes} exceeded 32768`);
        fullLogs += lp.data.content;
        if (!lp.data.has_more) break;
        logCursor = lp.data.next_cursor;
      }
      assert.ok(fullLogs.includes('FINAL_FAILURE_SUMMARY_MARKER'));

      // Check EVERY file in task runs/ and revisions/ has ZERO plaintext secret!
      const walkFiles = (dir: string): string[] => {
        const out: string[] = [];
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) out.push(...walkFiles(full));
          else if (entry.isFile()) out.push(full);
        }
        return out;
      };
      for (const file of walkFiles(path.join(dataDir, 'tasks', taskId))) {
        const content = fs.readFileSync(file, 'utf8');
        assert.equal(content.includes(secretKey), false, `Plaintext secret key leaked in ${file}`);
        assert.equal(content.includes('secretbody123'), false, `Plaintext bearer token leaked in ${file}`);
      }

      // Check wire-exact <=8192 B default recall over raw_trace
      const rawTracePage = await client.callToolWithFrameBytes('passbox_recall', {
        recall_id: c1.data.artifacts.recall_ids.raw_trace,
      });
      assert.ok(rawTracePage.frameBytes <= 8192, `default recall frameBytes ${rawTracePage.frameBytes} exceeded 8192`);

      // Part B: Cancel while verify_commands is running (create a second task with slow verify)
      const slowVerifyScript = `setTimeout(() => { require("node:fs").writeFileSync(${JSON.stringify(markerFile)}, "DONE"); }, 2500);`;
      const d2 = await client.callToolParsed('passbox_delegate', {
        objective: 'Cancel during active verify_commands',
        workspace: repoDir,
        contract: {
          verify_commands: [{ argv: [process.execPath, '-e', slowVerifyScript], timeout_seconds: 30 }],
        },
      });
      const taskId2 = d2.data.task_id as string;

      // Wait until task enters 'verifying' phase
      const deadline = Date.now() + 8000;
      let inVerifying = false;
      while (Date.now() < deadline) {
        const st = await client.callToolParsed('passbox_status', { task_id: taskId2 });
        if (st.data.phase === 'verifying') {
          inVerifying = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 80));
      }
      assert.equal(inVerifying, true, 'Expected task to enter verifying phase');

      const cancelVerifyRes = await client.callToolParsed('passbox_cancel', { task_id: taskId2 });
      assert.equal(cancelVerifyRes.data.canceled, true);
      assert.equal(cancelVerifyRes.data.confirmed_exited, true);

      const c2 = await client.callToolParsed('passbox_collect', { task_id: taskId2, wait_seconds: 0 });
      assert.equal(c2.data.execution_status, 'canceled');
      assert.equal(c2.data.verification_status, 'not_run');

      await new Promise((r) => setTimeout(r, 2700));
      assert.equal(fs.existsSync(markerFile), false, 'Canceled verification child must not finish writing marker');
    } finally {
      await client.close();
      cleanup();
      fs.rmSync(dataDir, { recursive: true, force: true });
      fs.rmSync(fakeStateDir, { recursive: true, force: true });
    }
  });
});
