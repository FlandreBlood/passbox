import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { fileURLToPath } from 'node:url';
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

    const scenario: FakeCodexScenarioFile = {
      steps: [
        // Run 1: simulates Windows console close (0xC000013A = 3221225786) mid-flight after 350ms
        {
          delay_ms: 350,
          report_mode: 'missing',
          exit_code: 3221225786,
          stderr: 'Console closed unexpectedly',
        },
        // Run 2: resumed with explicit model override -> succeeds with read-only review findings (0 file diff, verify not_run)
        {
          delay_ms: 80,
          report_mode: 'valid',
          report: {
            status: 'completed',
            blockers: [{ claim: 'P1｜缺少 worker 元数据判停过早', evidence: 'src/worker.ts:42' }],
            counter_evidence: [{ claim: '求解安全约束保持有效', evidence: 'src/native.ts:513' }],
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
        objective: '审查未提交改动的状态机边界',
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
        instruction: '继续完成审查报告输出',
        reset_context: false,
        model: 'gpt-5.4',
        reasoning_effort: 'high',
      });
      const s2 = JSON.parse(s2Raw.content[0].text);
      assert.equal(s2.action, 'started');
      assert.equal(s2.model, 'gpt-5.4');
      assert.equal(s2.model_source, 'explicit');

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
      const boardRes = await client2.callToolRaw('passbox_status', {});
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

      // Execute board.html script inside a simulated MCP App iframe VM and verify full DOM rendering + handshake!
      const rootEl = { innerHTML: '', scrollHeight: 360 };
      const msgListeners: Array<(ev: any) => void> = [];
      const postedToHost: any[] = [];
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
        navigator: { clipboard: { writeText: async () => {} } },
        document: {
          hidden: false,
          documentElement: {
            hasAttribute: () => false,
            setAttribute: () => {},
            style: { setProperty: () => {} },
          },
          body: { classList: { add: () => {} } },
          getElementById: (id: string) => (id === 'root' ? rootEl : null),
          querySelectorAll: () => [],
          addEventListener: () => {},
        },
        window: {
          matchMedia: () => ({ matches: false }),
          addEventListener: (type: string, fn: any) => {
            if (type === 'message') msgListeners.push(fn);
          },
          parent: {
            postMessage: (msg: any) => {
              postedToHost.push(msg);
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

      // Push boardRes via ui/notifications/tool-result and verify DOM renders both rows & Chinese exit reason!
      for (const l of msgListeners) {
        l({
          data: {
            jsonrpc: '2.0',
            method: 'ui/notifications/tool-result',
            params: boardRes,
          },
        });
      }
      assert.ok(rootEl.innerHTML.includes('Gemini 4 Carbon'), 'Board DOM must render Coordinator model');
      assert.ok(rootEl.innerHTML.includes('gpt-5.4'), 'Board DOM must render Codex resolved model');
      assert.ok(rootEl.innerHTML.includes('正常退出'), 'Board DOM must render Chinese exit reason');

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
