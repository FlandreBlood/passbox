import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  classifyExitReason,
  parseCodexConfigTomlText,
  readCodexSessionRolloutModel,
  resolveEffectiveCodexModel,
} from '../src/adapters/index.js';
import { DEFAULT_BUDGETS, mcpWireSerializedBytes } from '../src/firewall/index.js';
import { PASSBOX_BOARD_MIME_TYPE, PASSBOX_BOARD_RESOURCE_URI } from '../src/interface/index.js';
import type { FakeCodexScenarioFile } from './helpers/fake-codex.js';
import { createTempGitRepo } from './helpers/temp-git.js';
import { deriveTaskTitle, readLiveStream, resolveEvidenceFileLink, resolveWorkspaceFileLink } from '../src/session/index.js';
import { ArchiveStore } from '../src/observability/index.js';
import type { RunActivityItem } from '../src/types.js';

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(THIS_DIR, '..', '..');
const FAKE_CODEX_JS = path.join(THIS_DIR, 'helpers', 'fake-codex.js');
const MCP_SERVER_JS = path.join(REPO_ROOT, 'dist', 'interface', 'mcp-server.js');

class McpAppTestClient {
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

  request(method: string, params: Record<string, unknown> = {}): Promise<any> {
    const id = this.nextId++;
    return new Promise<any>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  async callToolRaw(name: string, args: Record<string, unknown>): Promise<any> {
    return this.request('tools/call', { name, arguments: args });
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

describe('Model Resolution, Exit Reason Classification & Bilingual Status Board MCP App', () => {
  it('merges sparse updates across live reads and bounds long command, verification and stderr tails', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'passbox-stream-'));
    try {
      const archive = new ArchiveStore(dataDir);
      const id = 'pb_live_tail';
      const run = { run_id: 'run_1', started_at: new Date().toISOString(), finished_at: null, published_revision: null };
      const paths = archive.runPaths(id, run.run_id);
      const read = () => readLiveStream(archive, id, dataDir, run);
      const emit = (event: object) => fs.appendFileSync(paths.rawTraceFile, JSON.stringify(event) + '\n');
      emit({ type: 'item.started', item: { id: 'operation', type: 'command_execution', command: 'check --token fixture-secret' } });
      assert.equal(read().entries[0].status, 'running');
      emit({ type: 'item.updated', item: { id: 'operation', aggregated_output: 'partial' } });
      assert.equal(read().entries[0].aggregated_output, 'partial');
      emit({ type: 'item.completed', item: { id: 'operation', exit_code: 0, aggregated_output: '😀'.repeat(2500) + ' last line' } });
      fs.writeFileSync(paths.stderrFile, '😀'.repeat(20000) + ' PASSWORD=fixture-stderr final marker\n');
      fs.writeFileSync(paths.verifyLogFile, 'check --password fixture-verify\n');
      const stream = read();
      assert.equal(stream.entries.length, 2);
      const cmd = stream.entries.find(e => e.kind === 'command_execution')!;
      assert.equal(cmd.status, 'completed');
      assert.equal(cmd.command, 'check --token [REDACTED]');
      assert.equal(cmd.exit_code, 0);
      assert.ok(cmd.truncated);
      assert.ok(cmd.aggregated_output!.endsWith('last line') && Buffer.byteLength(cmd.aggregated_output!) <= 4096);
      assert.ok(stream.stderr_truncated && stream.stderr_tail.endsWith('final marker\n'));
      assert.ok(Buffer.byteLength(stream.stderr_tail) <= 4096);
      assert.match(stream.entries.find(e => e.kind === 'verify')!.aggregated_output!, /\[REDACTED\]/);
      assert.doesNotMatch(JSON.stringify(stream), /fixture|\uFFFD/);
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('derives redacted titles by Unicode code point and skips Markdown section labels', () => {
    assert.equal(deriveTaskTitle('# Task Objective\n## Background\n> - 1. 修复   链接\n更多背景', ' \t'), '修复 链接');
    assert.equal(deriveTaskTitle('## 修复运行面板 ##\n正文'), '修复运行面板');
    assert.equal(deriveTaskTitle('# 任务目标\n> 使用 API_KEY=fixture-value'), '使用 API_KEY=[REDACTED]');
    assert.equal(deriveTaskTitle('other', '  中文 \n   API_KEY=fixture-key'), '中文 API_KEY=[REDACTED]');
    assert.equal(deriveTaskTitle('😀'.repeat(80)), '😀'.repeat(71) + '…');
  });

  it('parses config.toml profiles, session rollout headers, and classifies Windows 0xC000013A console interrupts', () => {
    const parsedToml = parseCodexConfigTomlText(`
      model = "gpt-5.3-codex"
      model_reasoning_effort = "medium"
      profile = "review"

      [profiles.review]
      model = "gpt-5.4"
      model_reasoning_effort = "high" # inline comment
    `);
    assert.equal(parsedToml.model, 'gpt-5.4');
    assert.equal(parsedToml.reasoningEffort, 'high');
    assert.equal(parsedToml.profile, 'review');

    const tmpCodexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'passbox-codex-home-'));
    try {
      const dayDir = path.join(tmpCodexHome, 'sessions', '2026', '11', '26');
      fs.mkdirSync(dayDir, { recursive: true });
      const threadId = '01a216b0-0aae-7f13-b37c-fcee1191ccbf';
      fs.writeFileSync(
        path.join(dayDir, `rollout-2026-11-26T15-09-21-${threadId}.jsonl`),
        `${JSON.stringify({
          type: 'session_meta',
          payload: { id: threadId, model: 'gpt-5.4-pro', effort: 'xhigh' },
        })}\n`,
        'utf8'
      );

      const rollout = readCodexSessionRolloutModel(threadId, tmpCodexHome);
      assert.equal(rollout.model, 'gpt-5.4-pro');
      assert.equal(rollout.reasoningEffort, 'xhigh');

      const resolvedFromRollout = resolveEffectiveCodexModel({
        threadId,
        codexHome: tmpCodexHome,
      });
      assert.equal(resolvedFromRollout.resolvedModel, 'gpt-5.4-pro');
      assert.equal(resolvedFromRollout.modelSource, 'session_rollout');
      assert.equal(resolvedFromRollout.reasoningEffort, 'xhigh');

      const resolvedExplicit = resolveEffectiveCodexModel({
        requestedModel: 'o3',
        requestedEffort: 'low',
        threadId,
        codexHome: tmpCodexHome,
      });
      assert.equal(resolvedExplicit.resolvedModel, 'o3');
      assert.equal(resolvedExplicit.modelSource, 'explicit');
      assert.equal(resolvedExplicit.reasoningEffort, 'low');
    } finally {
      fs.rmSync(tmpCodexHome, { recursive: true, force: true });
    }

    const winInterrupt = classifyExitReason({
      executionStatus: 'failed',
      exitCode: 3221225786,
    });
    assert.equal(winInterrupt.code, 'windows_console_interrupt');
    assert.equal(winInterrupt.signal_hex, '0xC000013A');
    assert.match(winInterrupt.label_zh, /Windows 控制台中断/);

    const normalOk = classifyExitReason({
      executionStatus: 'succeeded',
      exitCode: 0,
    });
    assert.equal(normalOk.code, 'normal');
  });

  it('resolves real file references and rejects prose, traversal, directories and escaping links', () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'passbox-links-'));
    const workspace = path.join(parent, 'work');
    const outside = path.join(parent, 'workspace-outside');
    const special = 'src/中文 空格 # %' + (process.platform === 'win32' ? '' : ' ?') + '.ts';
    try {
      fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
      fs.mkdirSync(outside);
      fs.writeFileSync(path.join(workspace, 'src/a.ts'), '');
      fs.writeFileSync(path.join(workspace, special), '');
      fs.writeFileSync(path.join(outside, 'outside.ts'), '');
      fs.symlinkSync(outside, path.join(workspace, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');

      const expected = pathToFileURL(fs.realpathSync.native(path.join(workspace, special))).href;
      assert.match(expected, /%E4%B8%AD%E6%96%87%20.*%23%20%25/);
      if (process.platform !== 'win32') assert.match(expected, /%3F/);
      assert.deepEqual(resolveWorkspaceFileLink(workspace, special), { uri: expected, rel_path: special });
      const simple = resolveWorkspaceFileLink(workspace, 'src/a.ts')!;
      assert.equal(simple.rel_path, 'src/a.ts');
      assert.equal(resolveEvidenceFileLink(workspace, simple.uri)?.uri, simple.uri);
      assert.equal(resolveEvidenceFileLink(workspace, 'src/a.ts:12')?.uri_with_line, simple.uri + '#L12');
      assert.deepEqual(resolveEvidenceFileLink(workspace, '\x60' + special + ':12:34\x60'), {
        uri: expected, rel_path: special, uri_with_line: expected + '#L12', line: 12, column: 34,
      });
      for (const reference of [special + ':12-20', special + '#L12-L20', expected + '#L12-L20']) {
        assert.deepEqual(resolveEvidenceFileLink(workspace, reference), {
          uri: expected, rel_path: special, uri_with_line: expected + '#L12-L20', line: 12, end_line: 20,
        });
      }
      const fragmentFilename = 'src/a.ts#L12';
      fs.writeFileSync(path.join(workspace, fragmentFilename), '');
      assert.deepEqual(resolveEvidenceFileLink(workspace, fragmentFilename), {
        uri: simple.uri + '%23L12', rel_path: fragmentFilename,
      });
      if (process.platform === 'win32') {
        const driveCase = workspace[0].toLowerCase() + workspace.slice(1);
        assert.equal(resolveEvidenceFileLink(driveCase, path.join(workspace, special) + ':12')?.uri, expected);
      } else {
        fs.writeFileSync(path.join(workspace, 'src/a.ts:12'), '');
        assert.equal(resolveEvidenceFileLink(workspace, 'src/a.ts:12')?.uri, simple.uri + ':12');
      }

      for (const rejected of [
        '', '   ', 'src/a.ts\nsrc/a.ts', '运行 npm test 通过', '见 src/a.ts:12 处说明',
        'src/a.ts:12 (缺少校验)', 'src', 'src:12', 'src/removed.ts', 'src/missing.ts:12',
        'src/../src/a.ts', '../workspace-outside/outside.ts', 'escape/outside.ts',
        path.join(outside, 'outside.ts'), pathToFileURL(path.join(outside, 'outside.ts')).href + '#L12',
        'https://example.invalid/src/a.ts:12', 'mailto:user@example.invalid', 'ui://src/a.ts',
        simple.uri + '#bad-L12', simple.uri + '?other=1', 'src/a.ts:0',
      ]) {
        assert.equal(resolveEvidenceFileLink(workspace, rejected), null, rejected);
      }
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });

  it('records independent verification starts and outcomes on the published round', async () => {
    const { repoDir, cleanup } = createTempGitRepo();
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'passbox-verify-activity-'));
    const client = new McpAppTestClient({ PLUGIN_DATA: dataDir, PASSBOX_CODEX_BIN: FAKE_CODEX_JS });
    try {
      await client.request('initialize', { protocolVersion: '2025-03-26' });
      const delegated = await client.callToolRaw('passbox_delegate', {
        objective: 'Check verification command timeline',
        workspace: repoDir,
        contract: {
          verify_commands: [
            { argv: [process.execPath, '-e', 'process.exitCode = 0', '--', '--token=test secret'] },
            { argv: [process.execPath, '-e', 'process.exitCode = 2'] },
          ],
        },
      });
      const { task_id } = JSON.parse(delegated.content[0].text);
      const collected = await client.callToolRaw('passbox_collect', { task_id, wait_seconds: 15 });
      assert.equal(JSON.parse(collected.content[0].text).verification_status, 'failed');

      const archive = new ArchiveStore(dataDir);
      const status = await client.callToolRaw('passbox_status', { task_id, include_detail: true });
      const detail = status.structuredContent.task_detail;
      assert.equal(detail.title, 'Check verification command timeline');
      assert.deepEqual(detail.selected_run_live.entries.filter((e: any) => e.kind === 'verify').map((e: any) => e.exit_code), [0, 2]);
      assert.doesNotMatch(JSON.stringify(status), /test secret/);
      const activities = archive.readRevisionMetadata(task_id, 1).activities!;
      const verifying = activities.findIndex((a) => a.kind === 'phase' && a.label === 'verifying');
      assert.ok(verifying >= 0);
      assert.deepEqual(activities.slice(verifying).map((a) => [a.kind, a.status]), [
        ['phase', 'started'], ['command', 'started'], ['command', 'completed'],
        ['command', 'started'], ['command', 'failed'], ['phase', 'completed'],
      ]);
      assert.match(activities[verifying + 1].label, /--token=\[REDACTED\]/);
      assert.doesNotMatch(JSON.stringify(activities), /test secret/);
      const big = 'API_KEY=fixture-big\n' + '😀中'.repeat(6000);
      const taskPath = archive.taskStateFile(task_id);
      const record = JSON.parse(fs.readFileSync(taskPath, 'utf8'));
      record.objective = record.runs[0].instruction = big;
      fs.writeFileSync(taskPath, JSON.stringify(record));
      const paths = archive.runPaths(task_id, 'run_1');
      fs.writeFileSync(paths.specFile, JSON.stringify({ prompt: big }));
      // No-id events keep independent keys. Partial final lines are retried on the next poll.
      const many = Array.from({ length: 145 }, (_, i) => JSON.stringify({
        type: 'item.completed', item: { type: 'reasoning', text: 'summary ' + i },
      })).join('\n');
      fs.writeFileSync(paths.rawTraceFile, many + '\n{"type":');
      const capped = await client.callToolRaw('passbox_status', { include_detail: true, task_id });
      const d = capped.structuredContent.task_detail;
      assert.ok(d.objective_truncated && d.rendered_prompt_truncated && d.runs_prompts[0].instruction_truncated);
      for (const [text, cap] of [[d.objective_full, 32768], [d.rendered_prompt, 24576], [d.runs_prompts[0].instruction_full, 16384]] as const) {
        assert.ok(Buffer.byteLength(text) <= cap && Buffer.byteLength(text) > cap - 4);
        assert.doesNotMatch(text, /fixture|\p{Cs}/u);
      }
      assert.ok(d.selected_run_live.entries.length <= 120 && d.selected_run_live.omitted_count >= 25);
      assert.ok(d.selected_run_live.entries.some((e: any) => e.text === 'summary 144'));
      assert.ok(mcpWireSerializedBytes(capped.content[0].text) <= 512);
      const invalid = await client.callToolRaw('passbox_status', { include_detail: true, task_id, run_id: '../run_1' });
      assert.ok(invalid.isError && mcpWireSerializedBytes(invalid.content[0].text) <= 512);
    } finally {
      await client.close();
      cleanup();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('passes explicit model/effort flags, surfaces Windows interrupt vs normal rounds in MCP App board, serves ui://passbox/board.html, and survives MCP server restart', async () => {
    const { repoDir, cleanup } = createTempGitRepo();
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'passbox-board-data-'));
    const fakeStateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'passbox-board-fake-'));
    const fakeCodexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'passbox-board-chome-'));

    fs.writeFileSync(
      path.join(fakeCodexHome, 'config.toml'),
      'model = "gpt-5.4-default"\nmodel_reasoning_effort = "medium"\n',
      'utf8'
    );

    const specialFile = 'src/中文 空格 # %.ts';
    const command = 'check sources API_KEY=fixture-api-42 --token="fixture with spaces" https://fixture-user:fixture-pass@host.invalid';
    const events = [
      { type: 'item.started', timestamp: '2026-01-01T12:00:00Z', item: { id: 'cmd1', type: 'command_execution', command } },
      { type: 'item.updated', item: { id: 'cmd1', type: 'command_execution', command, aggregated_output: 'ignore command output' } },
      { type: 'item.completed', timestamp: '2026-01-01T12:00:01Z', item: { id: 'cmd1', type: 'command_execution', command, exit_code: 1 } },
      { type: 'item.started', item: { id: 'tool1', type: 'mcp_tool_call', server: 'example', tool: 'list', arguments: { query: 'ignore tool arguments', token: 'fixture-private' } } },
      { type: 'item.completed', item: { id: 'tool1', type: 'mcp_tool_call', server: 'example', tool: 'list', status: 'completed', result: 'ignore tool result' } },
      { type: 'item.completed', item: { type: 'command_execution', command: 'approve-check', status: 'declined' } },
      { type: 'item.started', item: { type: 'agent_message', text: 'ignore agent start' } },
      { type: 'item.completed', item: { id: 'summary', type: 'reasoning', text: 'Visible summary API_KEY=fixture-priv' } },
      { type: 'item.completed', item: { type: 'collab_tool_call', tool: 'wait', result: 'ready' } },
      { type: 'item.completed', item: { type: 'file_change', changes: [{ path: specialFile }, { path: 'missing.ts' }] } },
    ];
    const scenario: FakeCodexScenarioFile = {
      steps: [
        // Run 1: simulates Windows console close (0xC000013A = 3221225786) mid-flight after 350ms
        {
          delay_ms: 350,
          report_mode: 'missing',
          exit_code: 3221225786,
          stderr: 'Console closed unexpectedly',
        },
        // Run 2: resumes with explicit model override and emits a burst of activity before completing.
        {
          delay_ms: 2000,
          hang_ms: 1800,
          stderr: 'tool diagnostic AUTH_TOKEN=fixture-stderr',
          events,
          events_after_delay: [{ type: 'item.completed', item: {
            type: 'web_search', query: 'follow-up lookup',
          } }],
          write_files: { [specialFile]: 'export const ok = true;' },
          delete_files: ['src-app.ts'],
          report_mode: 'valid',
          report: {
            status: 'completed',
            blockers: [
              { claim: 'Line reference', evidence: specialFile + ':42:3' },
              { claim: 'Prose', evidence: '运行 npm test 通过' },
              { claim: 'Deleted', evidence: 'src-app.ts:12' },
            ],
            counter_evidence: [
              { claim: 'Outside', evidence: path.join(fakeStateDir, 'scenario.json') },
              { claim: 'Annotated prose', evidence: specialFile + ':42 (缺少校验)' },
            ],
          },
        },
      ],
    };
    fs.writeFileSync(path.join(fakeStateDir, 'scenario.json'), JSON.stringify(scenario, null, 2), 'utf8');

    const env = {
      PLUGIN_DATA: dataDir,
      PASSBOX_CODEX_BIN: FAKE_CODEX_JS,
      PASSBOX_FAKE_CODEX_STATE_DIR: fakeStateDir,
      CODEX_HOME: fakeCodexHome,
    };

    let client1: McpAppTestClient | null = new McpAppTestClient(env);
    let client2: McpAppTestClient | null = null;

    try {
      const init = await client1.request('initialize', { protocolVersion: '2025-03-26' });
      assert.ok(init.capabilities.tools);
      assert.ok(init.capabilities.resources);

      // Verify MCP App UI resource listing & self-contained bilingual HTML
      const resList = await client1.request('resources/list');
      assert.equal(resList.resources.length, 1);
      assert.equal(resList.resources[0].uri, PASSBOX_BOARD_RESOURCE_URI);
      assert.equal(resList.resources[0].mimeType, PASSBOX_BOARD_MIME_TYPE);

      const resRead = await client1.request('resources/read', { uri: PASSBOX_BOARD_RESOURCE_URI });
      const html = resRead.contents[0].text as string;
      assert.ok(html.includes('ui/initialize'));
      assert.ok(html.includes('Passbox 状态面板'));
      assert.ok(html.includes('Passbox Mission Control'));
      assert.equal(/<script\s+src=/i.test(html), false, 'MCP App HTML must be self-contained with zero external script CDNs');

      // Parse & execute inline <script> in node:vm to catch any JS syntax/runtime errors and verify SEP-1865 handshake!
      const scriptMatch = /<script>([\s\S]*?)<\/script>/.exec(html);
      assert.ok(scriptMatch, 'Expected inline <script> in board.html');
      const vm = await import('node:vm');
      const compiledScript = new vm.Script(scriptMatch[1], { filename: 'board.html' });
      assert.ok(compiledScript);

      // Delegate Run 1 without explicit model (inherits config.toml "gpt-5.4-default") + caller info
      const d1Raw = await client1.callToolRaw('passbox_delegate', {
        title: '  审查  API_KEY=fixture-title',
        objective: '# 任务目标\n- 审查未提交改动的状态机边界\n完整目标 API_KEY=fixture-objective',
        contract: { acceptance: ['保持兼容 PASSWORD=fixture-contract'] },
        workspace: repoDir,
        caller: {
          agent: 'Antigravity',
          model: 'Gemini 4 Carbon',
        },
      });
      const d1 = JSON.parse(d1Raw.content[0].text);
      assert.equal(d1.model, 'gpt-5.4-default');
      assert.equal(d1.model_source, 'codex_config');
      assert.equal(d1.reasoning_effort, 'medium');
      const taskId = d1.task_id as string;

      // Close MCP server 1 immediately while Run 1 worker is still running -> worker must survive!
      await client1.close();
      client1 = null;

      client2 = new McpAppTestClient(env);
      await client2.request('initialize', { protocolVersion: '2025-03-26' });

      const c1Raw = await client2.callToolRaw('passbox_collect', {
        task_id: taskId,
        wait_seconds: 15,
      });
      const c1 = JSON.parse(c1Raw.content[0].text);
      assert.equal(c1.revision, 1);
      assert.equal(c1.execution_status, 'failed');
      assert.equal(c1.exit_code, 3221225786);
      assert.equal(c1.exit_reason.code, 'windows_console_interrupt');
      assert.equal(c1.verification_status, 'not_run');

      // Verify call-0 did NOT pass -m or -c since model was omitted
      const call0 = JSON.parse(fs.readFileSync(path.join(fakeStateDir, 'call-0.json'), 'utf8'));
      assert.equal(call0.modelArg, null);
      assert.deepEqual(call0.configArgs, []);

      // Steer Run 2 with explicit model="gpt-5.4" and reasoning_effort="high"
      const s2Raw = await client2.callToolRaw('passbox_steer', {
        task_id: taskId,
        instruction: '继续完成审查报告输出 PASSWORD=fixture-instruction',
        reset_context: false,
        model: 'gpt-5.4',
        reasoning_effort: 'high',
      });
      const s2 = JSON.parse(s2Raw.content[0].text);
      assert.equal(s2.action, 'started');
      assert.equal(s2.model, 'gpt-5.4');
      assert.equal(s2.model_source, 'explicit');

      const detailArgs = { task_id: taskId, include_board: true, include_detail: true, run_id: 'run_2' };
      let liveBoardRes = await client2.callToolRaw('passbox_status', detailArgs);
      const liveDeadline = Date.now() + 8000;
      // Trace, compact activities and stderr are independently appended. Wait
      // for the final event in the initial burst and its separate diagnostic.
      const initialBurstReady = (response: typeof liveBoardRes) => {
        const stream = response.structuredContent.task_detail?.selected_run_live;
        return stream?.entries.some((entry: any) => entry.kind === 'file_change') &&
          stream.stderr_tail.includes('tool diagnostic');
      };
      while (!initialBurstReady(liveBoardRes) && Date.now() < liveDeadline) {
        await new Promise((r) => setTimeout(r, 40));
        liveBoardRes = await client2.callToolRaw('passbox_status', detailArgs);
      }
      const liveRun = liveBoardRes.structuredContent.tasks[0].runs.at(-1);
      assert.equal(liveRun.execution_status, 'running');
      assert.equal(liveRun.revision, null);
      const liveDetail = liveBoardRes.structuredContent.task_detail;
      assert.equal(liveDetail.selected_run_id, 'run_2');
      assert.equal(liveDetail.title, '审查 API_KEY=[REDACTED]');
      assert.match(liveDetail.objective_full, /完整目标 API_KEY=\[REDACTED\]/);
      assert.ok(liveDetail.contract_summary.acceptance[0].endsWith('[REDACTED]'));
      assert.equal(liveDetail.runs_prompts[1].instruction_full, '继续完成审查报告输出 PASSWORD=[REDACTED]');
      assert.ok(liveDetail.rendered_prompt.startsWith('# Follow-up Guidance'));
      assert.ok(!liveDetail.objective_truncated && !liveDetail.rendered_prompt_truncated);
      assert.ok(mcpWireSerializedBytes(liveBoardRes.content[0].text) <= 512);
      assert.ok(Buffer.byteLength(JSON.stringify(liveBoardRes.structuredContent)) <= 240 * 1024);
      assert.doesNotMatch(JSON.stringify(liveDetail), /fixture/);
      const eventsByKind = (kind: string) => liveDetail.selected_run_live.entries.filter((e: any) => e.kind === kind);
      const cmd = eventsByKind('command_execution').filter((e: any) => e.key === 'item:cmd1');
      assert.equal(cmd.length, 1);
      assert.equal(cmd[0].aggregated_output, 'ignore command output');
      assert.equal(cmd[0].exit_code, 1);
      assert.equal(cmd[0].status, 'failed');
      assert.equal(cmd[0].duration_ms, 1000);
      assert.match(cmd[0].command, /check sources/);
      assert.match(eventsByKind('reasoning')[0].text, /Visible summary/);
      assert.match(eventsByKind('mcp_tool_call')[0].arguments, /ignore tool arguments/);
      assert.equal(eventsByKind('mcp_tool_call')[0].result, 'ignore tool result');
      assert.equal(eventsByKind('collab_tool_call')[0].text, 'wait');
      assert.equal(eventsByKind('file_change')[0].files[1].file_link, null);
      assert.match(liveDetail.selected_run_live.stderr_tail, /tool diagnostic/);
      const liveActivities: RunActivityItem[] = liveRun.activities;
      assert.deepEqual(liveActivities.filter((a) => ['command', 'tool'].includes(a.kind)).map((a) => [a.kind, a.status]), [
        ['command', 'started'], ['command', 'failed'], ['tool', 'started'], ['tool', 'completed'], ['command', 'declined'],
      ]);
      assert.equal(liveActivities.filter((a) => a.kind === 'phase' && a.label === 'investigating').length, 2);
      assert.ok(liveActivities.some((a) => a.label.includes('[REDACTED]')));
      assert.doesNotMatch(JSON.stringify(liveRun.activities), /fixture|ignore/);

      let refreshedLiveRes = liveBoardRes;
      const refreshDeadline = Date.now() + 5000;
      while (
        !refreshedLiveRes.structuredContent.tasks[0].runs.at(-1).activities.some(
          (activity: RunActivityItem) => activity.label === 'web_search: follow-up lookup'
        ) && Date.now() < refreshDeadline
      ) {
        await new Promise((r) => setTimeout(r, 40));
        refreshedLiveRes = await client2.callToolRaw('passbox_status', detailArgs);
      }
      const refreshedLiveRun = refreshedLiveRes.structuredContent.tasks[0].runs.at(-1);
      assert.equal(refreshedLiveRun.execution_status, 'running');
      assert.ok(refreshedLiveRun.activities.some((a: RunActivityItem) => a.label === 'web_search: follow-up lookup'));

      const c2Raw = await client2.callToolRaw('passbox_collect', {
        task_id: taskId,
        since_revision: 1,
        wait_seconds: 15,
      });
      const c2 = JSON.parse(c2Raw.content[0].text);
      assert.equal(c2.revision, 2);
      assert.equal(c2.execution_status, 'succeeded');
      assert.equal(c2.exit_reason.code, 'normal');
      assert.equal(c2.reported_status, 'completed');
      assert.equal(c2.verification_status, 'not_run');
      assert.equal(c2.model, 'gpt-5.4');
      assert.equal(c2.model_source, 'explicit');
      assert.equal(c2.reasoning_effort, 'high');

      // Verify call-1 (`codex exec resume`) received `-m gpt-5.4` and `-c model_reasoning_effort="high"`
      const call1 = JSON.parse(fs.readFileSync(path.join(fakeStateDir, 'call-1.json'), 'utf8'));
      assert.equal(call1.isResume, true);
      assert.equal(call1.modelArg, 'gpt-5.4');
      assert.deepEqual(call1.configArgs, ['model_reasoning_effort="high"']);

      // Verify MCP App `passbox_status({})` entrypoint launch returns <= 512B model text + rich structuredContent board
      await client2.close();
      client2 = new McpAppTestClient(env);
      await client2.request('initialize', { protocolVersion: '2025-03-26' });
      const fleet = await client2.callToolRaw('passbox_status', {});
      assert.equal(fleet.structuredContent.task_detail, undefined);
      // Exercise a legacy record and force the immutable revision trace fallback.
      const archive = new ArchiveStore(dataDir);
      const stateFile = archive.taskStateFile(taskId);
      const legacy = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      delete legacy.title;
      fs.writeFileSync(stateFile, JSON.stringify(legacy));
      fs.unlinkSync(archive.runPaths(taskId, 'run_2').rawTraceFile);
      const boardRes = await client2.callToolRaw('passbox_status', detailArgs);
      const history = await client2.callToolRaw('passbox_status', { ...detailArgs, run_id: 'run_1' });
      assert.ok(history.structuredContent.task_detail.rendered_prompt.startsWith('# Task Objective'));
      assert.equal(history.structuredContent.task_detail.selected_run_id, 'run_1');
      assert.equal(boardRes.structuredContent.task_detail.title, '审查未提交改动的状态机边界');
      const archived = boardRes.structuredContent.task_detail.selected_run_live.entries;
      assert.equal(archived.find((e: any) => e.report)?.report.status, 'completed');
      assert.ok(archived.some((e: any) => e.kind === 'web_search'));
      assert.ok(archived.find((e: any) => e.kind === 'file_change').files[0].file_link.uri);
      assert.equal(archived.find((e: any) => e.key === 'item:cmd1').exit_code, 1);
      assert.ok(
        mcpWireSerializedBytes(boardRes.content[0].text) <= DEFAULT_BUDGETS.statusBytes,
        'Model-facing passbox_status({}) text must remain <= 512 bytes'
      );
      const board = boardRes.structuredContent;
      assert.ok(board && Array.isArray(board.tasks));
      assert.equal(board.tasks.length, 1);

      const boardTask = board.tasks[0];
      assert.equal(boardTask.coordinator.agent, 'Antigravity');
      assert.equal(boardTask.coordinator.model, 'Gemini 4 Carbon');
      assert.equal(boardTask.executor.resolved_model, 'gpt-5.4');
      assert.equal(boardTask.executor.model_source, 'explicit');
      assert.equal(boardTask.executor.reasoning_effort, 'high');
      assert.equal(boardTask.runs.length, 2);
      assert.equal(boardTask.runs[0].exit_reason.code, 'windows_console_interrupt');
      assert.equal(boardTask.runs[1].execution_status, 'succeeded');
      assert.equal(boardTask.runs[1].reported_status, 'completed');
      assert.equal(boardTask.runs[1].verification_status, 'not_run');

      const detail = boardTask.runs[1];
      const specialUri = pathToFileURL(fs.realpathSync.native(path.join(repoDir, specialFile))).href;
      assert.equal(detail.delta_files.find((f: any) => f.path === 'src-app.ts').file_link, null);
      assert.equal(detail.delta_files.find((f: any) => f.path === specialFile).file_link.uri, specialUri);
      assert.equal(detail.unverified_blockers[0].evidence_link.uri_with_line, specialUri + '#L42');
      assert.equal(detail.unverified_blockers[0].evidence_link.column, 3);
      assert.ok(detail.unverified_blockers.slice(1).every((b: any) => b.evidence_link === null));
      assert.ok(detail.unverified_counter_evidence.every((b: any) => b.evidence_link === null));
      assert.deepEqual(detail.activities.at(-1), {
        at: detail.activities.at(-1).at, kind: 'phase', label: 'completed', status: 'completed',
      });
      assert.equal(boardTask.runs[0].activities.at(-1).status, 'failed');
      assert.ok(detail.activities.some((a: RunActivityItem) => a.label === 'agent_message emitted'));
      const meta = archive.readRevisionMetadata(taskId, 2);
      assert.deepEqual(detail.activities, meta.activities);
      assert.deepEqual(detail.activities_omitted_count, meta.activities_omitted_count);
      assert.doesNotMatch(fs.readFileSync(archive.runPaths(taskId, 'run_2').activitiesFile, 'utf8'), /fixture|ignore/);

      // Execute board.html script inside a simulated MCP App iframe VM and verify full DOM rendering + handshake!
      let htmlRendered = '';
      let activityList: { scrollTop: number; dataset: { activityRun: string } } | null = null;
      const rootEl = {
        set innerHTML(html: string) {
          htmlRendered = html;
          const match = /data-activity-run="([^"]+)"/.exec(html);
          activityList = match ? { scrollTop: 0, dataset: { activityRun: match[1] } } : null;
        },
        get innerHTML() { return htmlRendered; },
        scrollHeight: 360,
      };
      const msgListeners: Array<(ev: any) => void> = [];
      const postedToHost: any[] = [];
      const clicks: Array<(ev: any) => Promise<void>> = [];
      const copied: string[] = [];
      let pollResult = liveBoardRes;
      let openResult: 'fallback' | 'copy' | 'unsupported' = 'fallback';
      const deliver = (message: Record<string, unknown>) => {
        for (const listener of msgListeners) listener({ data: { jsonrpc: '2.0', ...message } });
      };
      const click = (attrs: Record<string, string>) => clicks[0]({
        target: { closest: () => ({ getAttribute: (key: string) => attrs[key] }) },
        stopPropagation: () => {},
      });
      const timers: NodeJS.Timeout[] = [];

      const vmSandbox: Record<string, any> = {
        console,
        Date,
        Math,
        Number,
        String,
        Boolean,
        Object,
        Array,
        Map,
        Set,
        JSON,
        Promise,
        Error,
        setTimeout: (fn: any, ms?: number) => {
          const id = setTimeout(fn, ms);
          id.unref();
          timers.push(id);
          return id;
        },
        clearTimeout,
        setInterval: (fn: any, ms?: number) => {
          const id = setInterval(fn, ms);
          id.unref();
          timers.push(id);
          return id;
        },
        clearInterval,
        requestAnimationFrame: (fn: any) => fn(),
        navigator: { clipboard: { writeText: async (value: string) => { copied.push(value); } } },
        document: {
          hidden: false,
          documentElement: {
            hasAttribute: () => false,
            setAttribute: () => {},
            style: { setProperty: () => {} },
          },
          body: { classList: { add: () => {} } },
          getElementById: (id: string) => (id === 'root' ? rootEl : null),
          querySelectorAll: (selector: string) => selector === '[data-activity-run]' && activityList ? [activityList] : [],
          addEventListener: (type: string, listener: (ev: any) => Promise<void>) => {
            if (type === 'click') clicks.push(listener);
          },
        },
        window: {
          matchMedia: () => ({ matches: false }),
          addEventListener: (type: string, fn: any) => {
            if (type === 'message') msgListeners.push(fn);
          },
          parent: {
            postMessage: (msg: any) => {
              postedToHost.push(msg);
              if (msg.method === 'tools/call') {
                queueMicrotask(() => deliver({ id: msg.id, result: pollResult }));
              }
              if (msg.method === 'com.google.antigravity/toggle-aux-pane') {
                queueMicrotask(() => deliver(openResult === 'unsupported'
                  ? { id: msg.id, error: { code: -32601, message: 'Unknown method' } }
                  : openResult === 'copy'
                    ? { id: msg.id, error: { code: -32000, message: 'Host rejected URI' } }
                    : { id: msg.id, result: { isError: msg.params.uri.includes('#L') } }));
              }
              if (msg && msg.method === 'ui/initialize') {
                queueMicrotask(() => {
                  for (const l of msgListeners) {
                    l({
                      data: {
                        jsonrpc: '2.0',
                        id: msg.id,
                        result: {
                          protocolVersion: '2026-01-26',
                          hostCapabilities: { serverTools: {} },
                          hostContext: { theme: 'dark' },
                        },
                      },
                    });
                  }
                });
              }
            },
          },
        },
      };
      vmSandbox.window.document = vmSandbox.document;
      vmSandbox.window.navigator = vmSandbox.navigator;

      compiledScript.runInNewContext(vmSandbox);
      await new Promise((r) => setTimeout(r, 30));

      assert.ok(postedToHost.some((m) => m.method === 'ui/initialize'), 'App must send ui/initialize');
      assert.ok(
        postedToHost.some((m) => m.method === 'ui/notifications/initialized'),
        'App must send ui/notifications/initialized'
      );

      await click({ 'data-action': 'refresh' });
      assert.match(rootEl.innerHTML, /运行活动/);
      assert.match(rootEl.innerHTML, /running cmd: check sources/);
      assert.match(rootEl.innerHTML, /calling example.list/);
      assert.ok(activityList);
      (activityList as { scrollTop: number }).scrollTop = 46;
      pollResult = refreshedLiveRes;
      await click({ 'data-action': 'refresh' });
      assert.match(rootEl.innerHTML, /web_search: follow-up lookup/);
      assert.equal((activityList as { scrollTop: number }).scrollTop, 46);

      pollResult = boardRes;
      await click({ 'data-action': 'refresh' });
      assert.equal((activityList as { scrollTop: number }).scrollTop, 46);
      assert.match(rootEl.innerHTML, /Gemini 4 Carbon/);
      assert.match(rootEl.innerHTML, /gpt-5.4/);
      assert.match(rootEl.innerHTML, /正常退出/);
      assert.match(rootEl.innerHTML, /agent_message emitted/);
      assert.match(rootEl.innerHTML, /<span class="claim-ev">运行 npm test 通过<\/span>/);
      assert.match(rootEl.innerHTML, /<span class="file-path">\[D\] src-app.ts<\/span>/);
      const linkedUris = Array.from(rootEl.innerHTML.matchAll(/data-action="open-file" data-uri="([^"]+)"/g), m => m[1]);
      assert.ok(linkedUris.length >= 3);
      assert.deepEqual([...new Set(linkedUris)], [specialUri]);
      assert.ok(rootEl.innerHTML.includes('data-uri-line="' + specialUri + '#L42"'));

      const fileAttrs = {
        'data-action': 'open-file', 'data-uri': specialUri,
        'data-uri-line': specialUri + '#L42', 'data-raw': specialFile + ':42:3',
      };
      const fileCalls = () => postedToHost.filter((m) => m.method === 'com.google.antigravity/toggle-aux-pane');
      await click(fileAttrs);
      assert.deepEqual(fileCalls().map((m) => m.params.uri), [specialUri + '#L42', specialUri]);
      assert.ok(fileCalls().every((m) => m.params.tabType === 'fileView'));
      assert.deepEqual(copied, []);
      openResult = 'copy';
      await click(fileAttrs);
      assert.deepEqual(fileCalls().slice(2).map((m) => m.params.uri), [specialUri + '#L42', specialUri]);
      assert.deepEqual(copied, [specialFile + ':42:3']);
      openResult = 'unsupported';
      await click(fileAttrs);
      assert.deepEqual(fileCalls().slice(4).map((m) => m.params.uri), [specialUri + '#L42']);
      assert.equal(copied.length, 2);

      assert.match(rootEl.innerHTML, /class="inspector"/);
      assert.match(rootEl.innerHTML, /完整提示词/);
      assert.match(rootEl.innerHTML, /完整目标 API_KEY=\[REDACTED\]/);
      assert.match(rootEl.innerHTML, /Visible summary/);

      // Verify stream filter pills hide/restore entries and token cache hit % renders on run_2
      await click({ 'data-action': 'set-stream-filter', 'data-stream-filter': 'command' });
      assert.doesNotMatch(rootEl.innerHTML, /Visible summary/);
      await click({ 'data-action': 'set-stream-filter', 'data-stream-filter': 'all' });
      assert.match(rootEl.innerHTML, /Visible summary/);

      const usageBoard = structuredClone(boardRes);
      usageBoard.structuredContent.tasks[0].runs[1].usage = {
        input_tokens: 1000,
        cached_input_tokens: 800,
        output_tokens: 50,
        reasoning_output_tokens: 20,
      };
      pollResult = usageBoard;
      await click({ 'data-action': 'refresh' });
      assert.match(rootEl.innerHTML, /80%/);
      pollResult = boardRes;
      await click({ 'data-action': 'refresh' });
      // Select a second master row, then return to the real task and inspect its first round.
      const second = { ...boardTask, title: 'Another queued review', task_id: 'pb_second' };
      const twoTasks = { ...boardRes, structuredContent: { ...board, tasks: [boardTask, second] } };
      pollResult = twoTasks;
      await click({ 'data-action': 'refresh' });
      pollResult = { ...twoTasks, structuredContent: { ...twoTasks.structuredContent,
        task_detail: { ...board.task_detail, title: second.title, task_id: second.task_id, objective_full: 'Second objective' } } };
      await click({ 'data-action': 'select-task', 'data-task': second.task_id });
      assert.match(rootEl.innerHTML, /workbench show-detail/);
      assert.match(rootEl.innerHTML, /selected" data-task-card="pb_second"/);
      assert.match(rootEl.innerHTML, /Second objective/);
      await click({ 'data-action': 'back' });
      assert.doesNotMatch(rootEl.innerHTML, /workbench show-detail/);
      pollResult = boardRes;
      await click({ 'data-action': 'select-task', 'data-task': taskId });
      pollResult = history;
      await click({ 'data-action': 'select-run', 'data-task': taskId, 'data-run': 'run_1' });
      assert.deepEqual(JSON.parse(JSON.stringify(postedToHost.filter(m => m.method === 'tools/call').at(-1).params.arguments)),
        { include_board: true, include_detail: true, task_id: taskId, run_id: 'run_1' });
      const key = taskId + '/run_1';
      await click({ 'data-action': 'envelope', 'data-key': key });
      assert.match(rootEl.innerHTML, /Final Response Protocol/);
      await click({ 'data-action': 'copy-prompt', 'data-key': key });
      assert.equal(copied.at(-1), history.structuredContent.task_detail.rendered_prompt);
      await click({ 'data-action': 'set-lang', 'data-lang': 'en' });
      assert.match(rootEl.innerHTML, /Live process stream/);
      assert.match(rootEl.innerHTML, /Back to tasks/);
      await click({ 'data-action': 'follow' });
      assert.match(rootEl.innerHTML, /data-action="follow" aria-pressed="false"/);

      // A new iframe obtains the persisted timeline from the reopened MCP server.
      assert.match(html, /body\.mode-inline \.master,\s*body\.mode-inline \.inspector\s*\{\s*max-height:\s*none;\s*overflow:\s*visible;/);
      assert.match(rootEl.innerHTML, /<details open class="detail-section" data-section-id="prompt"/);
      assert.match(rootEl.innerHTML, /class="disclosure-arrow"/);

      // Simulate inline hostContext + size-changed >= 220, AND pane hostContext pre-handshake tool-result race
      const makeRaceSandbox = (hostContext: Record<string, unknown>) => {
        const winListeners: Record<string, Array<(ev?: any) => void>> = {};
        const docListeners: Record<string, Array<(ev?: any) => void>> = {};
        const posted: any[] = [];
        const sb: Record<string, any> = {
          ...vmSandbox,
          document: {
            ...vmSandbox.document,
            addEventListener: (type: string, listener: (ev: any) => void) => {
              (docListeners[type] ||= []).push(listener);
              if (type === 'click') clicks.push(listener as any);
            },
          },
          window: {
            ...vmSandbox.window,
            scrollY: 0,
            scrollTo: () => {},
            addEventListener: (type: string, fn: any) => {
              (winListeners[type] ||= []).push(fn);
            },
            parent: {
              postMessage: (msg: any) => {
                posted.push(msg);
                if (msg.method === 'ui/initialize') {
                  for (const l of winListeners.message || []) {
                    l({ data: { jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: fleet } });
                  }
                  queueMicrotask(() => {
                    for (const l of winListeners.message || []) {
                      l({
                        data: {
                          jsonrpc: '2.0',
                          id: msg.id,
                          result: {
                            protocolVersion: '2026-01-26',
                            hostCapabilities: { serverTools: {} },
                            hostContext,
                          },
                        },
                      });
                    }
                  });
                } else if (msg.method === 'tools/call') {
                  queueMicrotask(() => {
                    for (const l of winListeners.message || []) {
                      l({ data: { jsonrpc: '2.0', id: msg.id, result: boardRes } });
                    }
                  });
                }
              },
            },
          },
        };
        sb.window.document = sb.document;
        sb.window.navigator = sb.navigator;
        return { sb, winListeners, docListeners, posted };
      };

      // 1) Inline mode: size-changed >= 220px
      const inlineCtx = makeRaceSandbox({ theme: 'dark', containerDimensions: { maxHeight: 720 } });
      rootEl.scrollHeight = 520;
      compiledScript.runInNewContext(inlineCtx.sb);
      await new Promise((r) => setTimeout(r, 40));
      const sizeNote = inlineCtx.posted.find((m) => m.method === 'ui/notifications/size-changed');
      assert.ok(sizeNote && sizeNote.params.height >= 220, 'Inline size-changed must grow >= 220px');

      // 2) Pane mode: pre-handshake fleet tool-result without task_detail must trigger include_detail: true on connect
      const paneCtx = makeRaceSandbox({ theme: 'dark' });
      compiledScript.runInNewContext(paneCtx.sb);
      await new Promise((r) => setTimeout(r, 40));
      assert.ok(
        paneCtx.posted.some((m) => m.method === 'tools/call' && m.params?.arguments?.include_detail === true),
        'Pre-handshake fleet tool-result must still trigger include_detail fetch after ui/initialize'
      );

      // 3) Verify poll render deferral while pointerDown is active (no scroll snap-back mid-drag)
      let delayToolsCall = false;
      const updatedBoard = structuredClone(boardRes);
      updatedBoard.structuredContent.tasks[0].title = 'Updated during drag';
      const origPost = paneCtx.sb.window.parent.postMessage;
      paneCtx.sb.window.parent.postMessage = (msg: any) => {
        if (delayToolsCall && msg.method === 'tools/call') {
          setTimeout(() => {
            for (const l of paneCtx.winListeners.message || []) {
              l({ data: { jsonrpc: '2.0', id: msg.id, result: updatedBoard } });
            }
          }, 15);
          return;
        }
        origPost(msg);
      };
      delayToolsCall = true;
      const runClickPromise = clicks.at(-1)!({
        target: {
          closest: () => ({
            getAttribute: (k: string) =>
              k === 'data-action' ? 'select-run' : k === 'data-task' ? taskId : k === 'data-run' ? 'run_2' : null,
          }),
        },
        stopPropagation: () => {},
      });
      for (const l of paneCtx.winListeners.pointerdown || []) l();
      rootEl.innerHTML = 'DRAG_SENTINEL';
      await runClickPromise;
      assert.equal(rootEl.innerHTML, 'DRAG_SENTINEL', 'fromPoll render must defer while pointerDown is active');
      for (const l of paneCtx.winListeners.pointerup || []) l();
      assert.match(rootEl.innerHTML, /Updated during drag/, 'Deferred poll render must flush on pointerup');

      // Also verify upward user scroll on a stream container pauses followTail & saves scrollTop
      for (const l of paneCtx.docListeners.scroll || []) {
        l({ target: { dataset: { scroll: 'stream/' + taskId + '/run_2' }, scrollTop: 42, scrollHeight: 500, clientHeight: 200 } });
      }
      assert.match(rootEl.innerHTML, /data-action="follow"/);

      compiledScript.runInNewContext(vmSandbox);
      await new Promise((r) => setTimeout(r, 30));
      deliver({ method: 'ui/notifications/tool-result', params: boardRes });
      assert.match(rootEl.innerHTML, /agent_message emitted/);

      for (const tId of timers) {
        clearTimeout(tId);
        clearInterval(tId);
      }
    } finally {
      if (client1) await client1.close();
      if (client2) await client2.close();
      cleanup();
      fs.rmSync(dataDir, { recursive: true, force: true });
      fs.rmSync(fakeStateDir, { recursive: true, force: true });
      fs.rmSync(fakeCodexHome, { recursive: true, force: true });
    }
  });
});
