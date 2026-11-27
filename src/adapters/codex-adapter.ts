import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import type {
  ExecutionStatus,
  ExecutorFinalReport,
  ExitReasonInfo,
  ModelSource,
  NativeHarnessEventClaim,
  ReasoningEffort,
  ReportedStatus,
  RunActivityItem,
  RunActivityStatus,
  TokenUsageSummary,
} from '../types.js';
import { writeAtomicJson, writeAtomicText } from '../observability/fs-atomic.js';
import { redactSensitiveText } from '../observability/redact.js';
import { sanitizeActivityItem } from '../firewall/budgets.js';
import { buildCodexSpawnCommand, resolveCodexBinary } from './codex-binary.js';
import {
  classifyExitReason,
  resolveEffectiveCodexModel,
  validateModelIdentifier,
  validateReasoningEffort,
} from './codex-model.js';
import {
  EXECUTOR_OUTPUT_JSON_SCHEMA,
  readAndParseExecutorReport,
} from './codex-schema.js';
import { terminateProcessTree } from './process-tree.js';

export interface CodexAdapterRunInput {
  executionWorkspace: string;
  prompt: string;
  resumeThreadId: string | null;
  model?: string | null;
  reasoningEffort?: ReasoningEffort | string | null;
  outputSchemaFile: string;
  lastMessageFile: string;
  rawTraceFile: string;
  stderrFile: string;
  timeoutMs?: number;
  signal: AbortSignal;
  onThreadStarted?: (threadId: string) => void;
  onPhaseChanged?: (phase: string) => void;
  onChildSpawned?: (pid: number) => void;
  onModelResolved?: (info: {
    resolvedModel: string | null;
    modelSource: ModelSource;
    reasoningEffort: string | null;
  }) => void;
  onLiveEvent?: (summary: string) => void;
  onActivity?: (activity: RunActivityItem) => void;
}

export interface CodexAdapterRunResult {
  executionStatus: Exclude<ExecutionStatus, 'running'>;
  reportedStatus: ReportedStatus;
  report: ExecutorFinalReport | null;
  threadId: string | null;
  exitCode: number | null;
  exitReason: ExitReasonInfo;
  durationMs: number;
  resolvedModel: string | null;
  modelSource: ModelSource;
  reasoningEffort: string | null;
  lastEvent: string | null;
  usage: TokenUsageSummary | null;
  nativeEvents: NativeHarnessEventClaim[];
  activities: RunActivityItem[];
  stderrSummary: string;
}

function buildNativeCodexEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  // Never leak snapshot temporary GIT_INDEX_FILE into Codex's native environment
  delete env.GIT_INDEX_FILE;
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  return env;
}

/**
 * Builds native `codex exec` or `codex exec resume` CLI arguments.
 * Preserves native CODEX_HOME, config.toml, AGENTS.md, skills, plugins, MCP, and sandbox/approval policies.
 * Respects `codex exec resume` flag asymmetry (never passes `-C`, `-s`, or `-a` on resume; cwd is set on child process).
 * Only appends `-m` / `-c model_reasoning_effort=...` when explicitly requested by caller.
 */
export function buildCodexExecArgs(params: {
  resumeThreadId: string | null;
  outputSchemaFile: string;
  lastMessageFile: string;
  model?: string | null;
  reasoningEffort?: ReasoningEffort | string | null;
}): string[] {
  const { resumeThreadId, outputSchemaFile, lastMessageFile } = params;
  const cleanModel = validateModelIdentifier(params.model);
  const cleanEffort = validateReasoningEffort(params.reasoningEffort);

  const modelFlags: string[] = [];
  if (cleanModel) {
    modelFlags.push('-m', cleanModel);
  }
  if (cleanEffort) {
    modelFlags.push('-c', `model_reasoning_effort="${cleanEffort}"`);
  }

  if (resumeThreadId) {
    return [
      'exec',
      'resume',
      ...modelFlags,
      '--json',
      '--output-schema',
      outputSchemaFile,
      '-o',
      lastMessageFile,
      resumeThreadId,
      '-',
    ];
  }
  return [
    'exec',
    ...modelFlags,
    '--json',
    '--output-schema',
    outputSchemaFile,
    '-o',
    lastMessageFile,
    '-',
  ];
}

function inferPhaseFromCodexItem(item: Record<string, unknown>): string | null {
  const itemType = String(item.type ?? '');
  if (itemType === 'file_change') return 'editing';
  if (itemType === 'agent_message') return 'responding';
  if (itemType === 'command_execution') {
    const cmd = String(item.command ?? '');
    if (/\b(test|pytest|vitest|jest|tsc|lint|check|cargo test|go test)\b/i.test(cmd)) {
      return 'verifying';
    }
    return 'investigating';
  }
  if (itemType === 'mcp_tool_call' || itemType === 'web_search') return 'investigating';
  return null;
}

function summarizeCodexLiveEvent(ev: Record<string, unknown>): string | null {
  const type = String(ev.type ?? '');
  if (type === 'thread.started' && typeof ev.thread_id === 'string') {
    return `thread.started (${ev.thread_id.slice(0, 12)})`;
  }
  if (type === 'turn.started') {
    return 'turn.started';
  }
  if (type === 'turn.completed') {
    return 'turn.completed';
  }
  if (type === 'turn.failed') {
    const errObj = ev.error as Record<string, unknown> | undefined;
    return `turn.failed: ${String(errObj?.message ?? 'error')}`;
  }
  if (
    (type === 'item.started' || type === 'item.completed') &&
    ev.item &&
    typeof ev.item === 'object'
  ) {
    const item = ev.item as Record<string, unknown>;
    const itemType = String(item.type ?? '');
    if (itemType === 'command_execution') {
      const cmd = String(item.command ?? '');
      if (item.status === 'declined') {
        return `declined cmd: ${cmd}`;
      }
      const prefix = type === 'item.started' ? 'running cmd' : 'ran cmd';
      return `${prefix}: ${cmd}`;
    }
    if (itemType === 'mcp_tool_call') {
      const srv = String(item.server ?? 'mcp');
      const tool = String(item.tool ?? 'call');
      return `${type === 'item.started' ? 'calling' : 'done'} ${srv}.${tool}`;
    }
    if (itemType === 'file_change') {
      const changes = Array.isArray(item.changes) ? item.changes : [];
      const paths = changes
        .map((c) => (c && typeof c === 'object' ? String((c as Record<string, unknown>).path ?? '') : ''))
        .filter(Boolean);
      return paths.length > 0
        ? `edited ${paths.slice(0, 2).join(', ')}${paths.length > 2 ? ` (+${paths.length - 2})` : ''}`
        : 'file_change';
    }
    if (itemType === 'web_search') {
      return `web_search: ${String(item.query ?? '')}`;
    }
    if (itemType === 'agent_message' && type === 'item.completed') {
      return 'agent_message emitted';
    }
    if (itemType === 'error' && typeof item.message === 'string') {
      return `notice: ${item.message}`;
    }
  }
  return null;
}

export async function runNativeCodexTurn(
  input: CodexAdapterRunInput
): Promise<CodexAdapterRunResult> {
  const startedAtMs = Date.now();
  const binary = resolveCodexBinary();
  const requestedModel = validateModelIdentifier(input.model);
  const requestedEffort = validateReasoningEffort(input.reasoningEffort);

  writeAtomicJson(input.outputSchemaFile, EXECUTOR_OUTPUT_JSON_SCHEMA);
  try {
    fs.rmSync(input.lastMessageFile, { force: true });
  } catch {}

  const cliArgs = buildCodexExecArgs({
    resumeThreadId: input.resumeThreadId,
    outputSchemaFile: input.outputSchemaFile,
    lastMessageFile: input.lastMessageFile,
    model: requestedModel,
    reasoningEffort: requestedEffort,
  });
  const spawnCmd = buildCodexSpawnCommand(binary, cliArgs);
  const timeoutMs = input.timeoutMs ?? 30 * 60 * 1000;

  const traceFd = fs.openSync(input.rawTraceFile, 'a');
  const stderrFd = fs.openSync(input.stderrFile, 'a');

  let threadId: string | null = input.resumeThreadId;
  let streamModel: string | null = null;
  let lastAgentMessage: string | null = null;
  let lastEvent: string | null = null;
  let turnCompleted = false;
  let turnFailed = false;
  let timedOut = false;
  let canceled = false;
  let usage: TokenUsageSummary | null = null;
  const nativeEvents: NativeHarnessEventClaim[] = [];
  const activities: RunActivityItem[] = [];
  let stderrTail = '';
  let currentPhase = 'starting';

  let currentModelInfo = resolveEffectiveCodexModel({
    requestedModel,
    requestedEffort,
    threadId,
  });
  input.onModelResolved?.(currentModelInfo);

  const refreshModelInfo = () => {
    const next = resolveEffectiveCodexModel({
      requestedModel,
      requestedEffort,
      streamModel,
      threadId,
    });
    if (
      next.resolvedModel !== currentModelInfo.resolvedModel ||
      next.modelSource !== currentModelInfo.modelSource ||
      next.reasoningEffort !== currentModelInfo.reasoningEffort
    ) {
      currentModelInfo = next;
      input.onModelResolved?.(next);
    }
  };

  const recordNativeEvent = (msg: string) => {
    const clean = redactSensitiveText(msg.trim());
    if (!clean) return;
    if (nativeEvents.length < 8 && !nativeEvents.some((e) => e.message === clean)) {
      nativeEvents.push({ source: 'native_harness_event', message: clean.slice(0, 400) });
    }
  };

  const recordLiveEvent = (rawSummary: string | null) => {
    if (!rawSummary) return;
    const clean = redactSensitiveText(rawSummary).replace(/\s+/g, ' ').trim().slice(0, 160);
    if (!clean || clean === lastEvent) return;
    lastEvent = clean;
    input.onLiveEvent?.(clean);
  };

  const recordActivity = (kind: RunActivityItem['kind'], label: string, status: RunActivityStatus) => {
    const activity = sanitizeActivityItem({ at: new Date().toISOString(), kind, label, status });
    if (!activity) return;
    activities.push(activity);
    input.onActivity?.(activity);
  };

  const setPhase = (nextPhase: string | null) => {
    if (nextPhase && nextPhase !== currentPhase) {
      currentPhase = nextPhase;
      recordActivity('phase', nextPhase, 'info');
      input.onPhaseChanged?.(nextPhase);
    }
  };

  const handleJsonEvent = (ev: Record<string, unknown>) => {
    const type = String(ev.type ?? '');
    if (typeof ev.model === 'string' && ev.model.trim()) {
      streamModel = ev.model.trim().slice(0, 80);
      refreshModelInfo();
    }
    const item = ev.item && typeof ev.item === 'object'
      ? ev.item as Record<string, unknown>
      : null;
    if (type === 'thread.started' || type === 'turn.started') {
      setPhase('investigating');
    } else if (item && (type === 'item.started' || type === 'item.updated' || type === 'item.completed')) {
      setPhase(inferPhaseFromCodexItem(item));
    }
    const summary = summarizeCodexLiveEvent(ev);
    recordLiveEvent(summary);

    if (type === 'thread.started') {
      recordActivity('notice', 'thread.started', 'started');
      if (typeof ev.thread_id === 'string' && ev.thread_id) {
        threadId = ev.thread_id;
        input.onThreadStarted?.(ev.thread_id);
        refreshModelInfo();
      }
      return;
    }
    if (type === 'turn.started') {
      recordActivity('turn', type, 'started');
      refreshModelInfo();
      return;
    }
    if (type === 'turn.completed') {
      recordActivity('turn', type, 'completed');
      turnCompleted = true;
      if (ev.usage && typeof ev.usage === 'object') {
        usage = ev.usage as TokenUsageSummary;
      }
      return;
    }
    if (type === 'turn.failed') {
      recordActivity('turn', summary ?? type, 'failed');
      turnFailed = true;
      const errObj = ev.error as Record<string, unknown> | undefined;
      recordNativeEvent(String(errObj?.message ?? 'Codex turn.failed event'));
      return;
    }
    if (type === 'error') {
      const message = String(ev.message ?? 'Codex stream error');
      recordActivity('notice', message, 'failed');
      recordNativeEvent(message);
      return;
    }
    if (
      (type === 'item.started' || type === 'item.updated' || type === 'item.completed') &&
      item
    ) {
      if (type !== 'item.updated') {
        let status: RunActivityStatus = type === 'item.started' ? 'started' : 'completed';
        if (item.status === 'declined') status = 'declined';
        else if (item.status === 'canceled' || item.status === 'cancelled') status = 'canceled';
        else if (item.type === 'error' || item.status === 'failed' ||
          (typeof item.exit_code === 'number' && item.exit_code !== 0)) status = 'failed';

        switch (item.type) {
          case 'command_execution':
            recordActivity('command', summary ?? 'command_execution', status);
            break;
          case 'mcp_tool_call':
          case 'web_search':
            recordActivity('tool', summary ?? item.type, status);
            break;
          case 'file_change':
            recordActivity('file_change', summary ?? item.type, status);
            break;
          case 'agent_message':
            if (type === 'item.completed') recordActivity('notice', 'agent_message emitted', status);
            break;
          case 'error':
            recordActivity('notice', summary ?? 'error', status);
            break;
        }
      }
      if (item.type === 'agent_message' && typeof item.text === 'string') {
        lastAgentMessage = item.text;
      }
      if (item.status === 'declined') {
        recordNativeEvent(
          `Native approval or sandbox declined ${String(item.type ?? 'operation')}: ${String(item.command ?? item.id ?? '')}`
        );
      }
      if (item.type === 'error' && typeof item.message === 'string') {
        recordNativeEvent(item.message);
      }
    }
  };

  try {
    const child = spawn(spawnCmd.cmd, spawnCmd.args, {
      cwd: input.executionWorkspace,
      env: buildNativeCodexEnv(),
      detached: process.platform !== 'win32',
      windowsHide: true,
      windowsVerbatimArguments: spawnCmd.windowsVerbatimArguments,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    if (child.pid) {
      input.onChildSpawned?.(child.pid);
    }

    if (child.stdin) {
      child.stdin.on('error', () => {});
      child.stdin.end(input.prompt, 'utf8');
    }

    const decoder = new StringDecoder('utf8');
    let lineBuf = '';
    const writeRedactedTraceLine = (line: string) => {
      try {
        fs.writeSync(traceFd, Buffer.from(`${redactSensitiveText(line)}\n`, 'utf8'));
      } catch {}
    };
    const consumeLines = (chunkStr: string, flushAll = false) => {
      lineBuf += chunkStr;
      let nlIdx: number;
      while ((nlIdx = lineBuf.indexOf('\n')) !== -1) {
        const rawLine = lineBuf.slice(0, nlIdx).trim();
        lineBuf = lineBuf.slice(nlIdx + 1);
        if (!rawLine) continue;
        writeRedactedTraceLine(rawLine);
        try {
          const parsed = JSON.parse(rawLine);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            handleJsonEvent(parsed as Record<string, unknown>);
          }
        } catch {}
      }
      if (flushAll && lineBuf.trim()) {
        const remaining = lineBuf.trim();
        writeRedactedTraceLine(remaining);
        try {
          const parsed = JSON.parse(remaining);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            handleJsonEvent(parsed as Record<string, unknown>);
          }
        } catch {}
        lineBuf = '';
      }
    };

    const stderrDecoder = new StringDecoder('utf8');
    let stderrLineBuf = '';
    const consumeStderrText = (decoded: string, flushAll = false) => {
      stderrLineBuf += decoded;
      let nlIdx: number;
      while ((nlIdx = stderrLineBuf.indexOf('\n')) !== -1) {
        const lineWithNl = stderrLineBuf.slice(0, nlIdx + 1);
        stderrLineBuf = stderrLineBuf.slice(nlIdx + 1);
        const cleanLine = redactSensitiveText(lineWithNl);
        try {
          fs.writeSync(stderrFd, Buffer.from(cleanLine, 'utf8'));
        } catch {}
        stderrTail = (stderrTail + cleanLine).slice(-4096);
      }
      if (flushAll && stderrLineBuf.length > 0) {
        const cleanRem = redactSensitiveText(stderrLineBuf);
        try {
          fs.writeSync(stderrFd, Buffer.from(cleanRem, 'utf8'));
        } catch {}
        stderrTail = (stderrTail + cleanRem).slice(-4096);
        stderrLineBuf = '';
      }
    };

    child.stdout?.on('data', (chunk: Buffer) => {
      consumeLines(decoder.write(chunk));
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      consumeStderrText(stderrDecoder.write(chunk));
    });

    let stoppingPromise: Promise<void> | null = null;
    const stopChild = (reason: 'cancel' | 'timeout') => {
      if (reason === 'cancel') canceled = true;
      if (reason === 'timeout') timedOut = true;
      if (!stoppingPromise && child.pid) {
        stoppingPromise = terminateProcessTree(child.pid);
      }
    };

    const onAbort = () => stopChild('cancel');
    input.signal.addEventListener('abort', onAbort, { once: true });
    if (input.signal.aborted) stopChild('cancel');

    const timeoutTimer = setTimeout(() => stopChild('timeout'), timeoutMs);

    let spawnError: Error | null = null;
    const exitCode = await new Promise<number | null>((resolve) => {
      child.once('error', (err) => {
        spawnError = err;
        resolve(null);
      });
      child.once('close', (code) => resolve(code));
    });

    clearTimeout(timeoutTimer);
    input.signal.removeEventListener('abort', onAbort);
    if (stoppingPromise) {
      await stoppingPromise;
    }

    consumeLines(decoder.end(), true);
    consumeStderrText(stderrDecoder.end(), true);
    refreshModelInfo();

    if (spawnError) {
      recordNativeEvent(`Failed to launch Codex CLI: ${(spawnError as Error).message}`);
    }

    const cleanedStderr = redactSensitiveText(
      stderrTail
        .split(/\r?\n/)
        .filter((l) => l.trim() && !l.startsWith('WARNING: proceeding, even though we could not update PATH:'))
        .join('\n')
        .trim()
    );
    if (cleanedStderr && (exitCode !== 0 || turnFailed)) {
      recordNativeEvent(cleanedStderr.slice(0, 350));
    }

    const { reportedStatus, report } = readAndParseExecutorReport(
      input.lastMessageFile,
      lastAgentMessage
    );

    if (input.lastMessageFile && fs.existsSync(input.lastMessageFile)) {
      try {
        const rawLastMsg = fs.readFileSync(input.lastMessageFile, 'utf8');
        const redactedLastMsg = redactSensitiveText(rawLastMsg);
        if (redactedLastMsg !== rawLastMsg) {
          writeAtomicText(input.lastMessageFile, redactedLastMsg);
        }
      } catch {}
    }

    let executionStatus: Exclude<ExecutionStatus, 'running'>;
    if (canceled) {
      executionStatus = 'canceled';
    } else if (timedOut) {
      executionStatus = 'timed_out';
    } else if (spawnError || turnFailed || exitCode !== 0 || !turnCompleted) {
      executionStatus = 'failed';
    } else {
      executionStatus = 'succeeded';
    }

    const durationMs = Math.max(0, Date.now() - startedAtMs);
    const exitReason = classifyExitReason({
      executionStatus,
      exitCode,
      turnCompleted,
      turnFailed,
      spawnError: Boolean(spawnError),
    });

    return {
      executionStatus,
      reportedStatus,
      report,
      threadId,
      exitCode,
      exitReason,
      durationMs,
      resolvedModel: currentModelInfo.resolvedModel,
      modelSource: currentModelInfo.modelSource,
      reasoningEffort: currentModelInfo.reasoningEffort,
      lastEvent,
      usage,
      nativeEvents,
      activities,
      stderrSummary: cleanedStderr.slice(0, 600),
    };
  } finally {
    try {
      fs.closeSync(traceFd);
    } catch {}
    try {
      fs.closeSync(stderrFd);
    } catch {}
  }
}
