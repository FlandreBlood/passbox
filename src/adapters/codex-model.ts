import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  CallerMetadata,
  ExecutionStatus,
  ExitReasonInfo,
  ModelSource,
  ReasoningEffort,
} from '../types.js';
import { redactSensitiveText } from '../observability/redact.js';

const VALID_EFFORTS = new Set<ReasoningEffort>(['minimal', 'low', 'medium', 'high', 'xhigh']);

/**
 * Validates an optional user-supplied model identifier.
 * Rejects leading dashes or whitespace/shell metacharacters so CLI flags cannot be injected.
 */
export function validateModelIdentifier(raw: unknown): string | null {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string') {
    throw new Error('`model` must be a non-empty string when provided.');
  }
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('-') || trimmed.length > 120 || !/^[A-Za-z0-9._:/-]+$/.test(trimmed)) {
    throw new Error(
      `Invalid \`model\` identifier "${trimmed}". Expected a model name such as "gpt-5.4" or "o3".`
    );
  }
  return trimmed;
}

export function validateReasoningEffort(raw: unknown): ReasoningEffort | null {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string') {
    throw new Error('`reasoning_effort` must be one of "minimal", "low", "medium", "high", "xhigh".');
  }
  const normalized = raw.trim().toLowerCase() as ReasoningEffort;
  if (!VALID_EFFORTS.has(normalized)) {
    throw new Error(
      `Invalid \`reasoning_effort\` "${raw}". Must be one of: minimal, low, medium, high, xhigh.`
    );
  }
  return normalized;
}

export function sanitizeCallerMetadata(raw: unknown): CallerMetadata | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('`caller` must be an object `{ agent?, model?, session_id? }` when provided.');
  }
  const obj = raw as Record<string, unknown>;
  const cleanField = (val: unknown, maxLen: number): string | undefined => {
    if (typeof val !== 'string') return undefined;
    const trimmed = redactSensitiveText(val.trim()).slice(0, maxLen);
    return trimmed || undefined;
  };
  const agent = cleanField(obj.agent, 64);
  const model = cleanField(obj.model, 80);
  const session_id = cleanField(obj.session_id, 80);
  if (!agent && !model && !session_id) return null;
  return {
    ...(agent ? { agent } : {}),
    ...(model ? { model } : {}),
    ...(session_id ? { session_id } : {}),
  };
}

export function resolveCodexHomeDir(explicitCodexHome?: string): string {
  if (explicitCodexHome && explicitCodexHome.trim()) {
    return path.resolve(explicitCodexHome.trim());
  }
  if (process.env.CODEX_HOME && process.env.CODEX_HOME.trim()) {
    return path.resolve(process.env.CODEX_HOME.trim());
  }
  const home = process.platform === 'win32' ? process.env.USERPROFILE || os.homedir() : os.homedir();
  return path.join(home, '.codex');
}

export interface CodexConfigDefaults {
  model: string | null;
  reasoningEffort: string | null;
  profile: string | null;
}

function unquoteTomlString(rawVal: string): string | null {
  const trimmed = rawVal.trim();
  if (!trimmed) return null;
  const dqMatch = /^"((?:\\.|[^"\\])*)"\s*(?:#.*)?$/.exec(trimmed);
  if (dqMatch) {
    return dqMatch[1].trim() || null;
  }
  const sqMatch = /^'([^']*)'\s*(?:#.*)?$/.exec(trimmed);
  if (sqMatch) {
    return sqMatch[1].trim() || null;
  }
  // Strip inline comment outside quotes
  const hashIdx = trimmed.indexOf('#');
  const bare = (hashIdx === -1 ? trimmed : trimmed.slice(0, hashIdx)).trim();
  return bare || null;
}

/**
 * Read-only parser for non-secret model defaults in `${CODEX_HOME}/config.toml`.
 * Never reads `auth.json` or mutates any user configuration.
 */
export function parseCodexConfigTomlText(tomlText: string): CodexConfigDefaults {
  let rootModel: string | null = null;
  let rootEffort: string | null = null;
  let activeProfile: string | null = null;
  const profileModels = new Map<string, { model?: string; effort?: string }>();

  let currentSection = '';
  for (const rawLine of tomlText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const secMatch = /^\[([^\]]+)\]\s*(?:#.*)?$/.exec(line);
    if (secMatch) {
      currentSection = secMatch[1].trim();
      continue;
    }
    const kvMatch = /^([A-Za-z0-9_-]+)\s*=\s*(.+)$/.exec(line);
    if (!kvMatch) continue;
    const key = kvMatch[1];
    const val = unquoteTomlString(kvMatch[2]);
    if (!val) continue;

    if (!currentSection) {
      if (key === 'model') rootModel = val;
      else if (key === 'model_reasoning_effort') rootEffort = val;
      else if (key === 'profile') activeProfile = val;
    } else {
      const profMatch = /^profiles\.([A-Za-z0-9_.-]+)$/.exec(currentSection);
      if (profMatch) {
        const profName = profMatch[1];
        const entry = profileModels.get(profName) ?? {};
        if (key === 'model') entry.model = val;
        else if (key === 'model_reasoning_effort') entry.effort = val;
        profileModels.set(profName, entry);
      }
    }
  }

  const selectedProf = activeProfile ? profileModels.get(activeProfile) : undefined;
  return {
    model: selectedProf?.model ?? rootModel ?? null,
    reasoningEffort: selectedProf?.effort ?? rootEffort ?? null,
    profile: activeProfile,
  };
}

export function readCodexConfigDefaults(explicitCodexHome?: string): CodexConfigDefaults {
  try {
    const cfgFile = path.join(resolveCodexHomeDir(explicitCodexHome), 'config.toml');
    if (!fs.existsSync(cfgFile)) {
      return { model: null, reasoningEffort: null, profile: null };
    }
    const raw = fs.readFileSync(cfgFile, 'utf8').slice(0, 64 * 1024);
    return parseCodexConfigTomlText(raw);
  } catch {
    return { model: null, reasoningEffort: null, profile: null };
  }
}

function findRolloutFileForThread(sessionsDir: string, threadId: string): string | null {
  if (!threadId || !/^[A-Za-z0-9_-]{6,80}$/.test(threadId)) return null;
  if (!fs.existsSync(sessionsDir)) return null;

  // Walk newest year/month/day directories first (bounded scan <= 60 dirs)
  let scannedDirs = 0;
  const listDesc = (dir: string): string[] => {
    try {
      return fs.readdirSync(dir).sort().reverse();
    } catch {
      return [];
    }
  };

  for (const year of listDesc(sessionsDir).slice(0, 3)) {
    const yearDir = path.join(sessionsDir, year);
    for (const month of listDesc(yearDir).slice(0, 4)) {
      const monthDir = path.join(yearDir, month);
      for (const day of listDesc(monthDir).slice(0, 8)) {
        if (++scannedDirs > 40) return null;
        const dayDir = path.join(monthDir, day);
        let files: string[] = [];
        try {
          files = fs.readdirSync(dayDir);
        } catch {
          continue;
        }
        const match = files.find((f) => f.includes(threadId) && f.endsWith('.jsonl'));
        if (match) {
          return path.join(dayDir, match);
        }
      }
    }
  }
  return null;
}

/**
 * Inspects the first 16 KiB of Codex's native session rollout file (`~/.codex/sessions/...`)
 * for `threadId` to extract the exact runtime `model` and `effort` negotiated by Codex CLI.
 */
export function readCodexSessionRolloutModel(
  threadId: string | null | undefined,
  explicitCodexHome?: string
): { model: string | null; reasoningEffort: string | null } {
  if (!threadId) return { model: null, reasoningEffort: null };
  try {
    const sessionsDir = path.join(resolveCodexHomeDir(explicitCodexHome), 'sessions');
    const rolloutPath = findRolloutFileForThread(sessionsDir, threadId);
    if (!rolloutPath) return { model: null, reasoningEffort: null };

    const fd = fs.openSync(rolloutPath, 'r');
    try {
      const buf = Buffer.alloc(16 * 1024);
      const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
      const snippet = buf.subarray(0, bytesRead).toString('utf8');
      let foundModel: string | null = null;
      let foundEffort: string | null = null;

      for (const rawLine of snippet.split(/\r?\n/).slice(0, 12)) {
        const trimmed = rawLine.trim();
        if (!trimmed.startsWith('{')) continue;
        try {
          const obj = JSON.parse(trimmed) as Record<string, unknown>;
          const payload = (obj.payload && typeof obj.payload === 'object'
            ? obj.payload
            : obj) as Record<string, unknown>;
          if (!foundModel && typeof payload.model === 'string' && payload.model.trim()) {
            foundModel = payload.model.trim().slice(0, 80);
          }
          const collab = payload.collaboration_mode as Record<string, unknown> | undefined;
          const settings = collab?.settings as Record<string, unknown> | undefined;
          if (!foundModel && typeof settings?.model === 'string' && settings.model.trim()) {
            foundModel = settings.model.trim().slice(0, 80);
          }
          const rawEffort =
            payload.effort ??
            payload.reasoning_effort ??
            payload.model_reasoning_effort ??
            settings?.reasoning_effort;
          if (!foundEffort && typeof rawEffort === 'string' && rawEffort.trim()) {
            foundEffort = rawEffort.trim().slice(0, 32);
          }
          if (foundModel && foundEffort) break;
        } catch {}
      }
      return { model: foundModel, reasoningEffort: foundEffort };
    } finally {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  } catch {
    return { model: null, reasoningEffort: null };
  }
}

export function resolveEffectiveCodexModel(params: {
  requestedModel?: string | null;
  requestedEffort?: string | null;
  streamModel?: string | null;
  threadId?: string | null;
  codexHome?: string;
}): {
  resolvedModel: string | null;
  modelSource: ModelSource;
  reasoningEffort: string | null;
} {
  const cfg = readCodexConfigDefaults(params.codexHome);
  const rollout =
    !params.requestedModel && !params.streamModel && params.threadId
      ? readCodexSessionRolloutModel(params.threadId, params.codexHome)
      : { model: null, reasoningEffort: null };

  const effectiveEffort =
    params.requestedEffort || rollout.reasoningEffort || cfg.reasoningEffort || null;

  if (params.requestedModel) {
    return {
      resolvedModel: params.requestedModel,
      modelSource: 'explicit',
      reasoningEffort: effectiveEffort,
    };
  }
  if (params.streamModel) {
    return {
      resolvedModel: params.streamModel,
      modelSource: 'stream_event',
      reasoningEffort: effectiveEffort,
    };
  }
  if (rollout.model) {
    return {
      resolvedModel: rollout.model,
      modelSource: 'session_rollout',
      reasoningEffort: effectiveEffort,
    };
  }
  if (cfg.model) {
    return {
      resolvedModel: cfg.model,
      modelSource: 'codex_config',
      reasoningEffort: effectiveEffort,
    };
  }
  return {
    resolvedModel: null,
    modelSource: 'codex_cli_default',
    reasoningEffort: effectiveEffort,
  };
}

/**
 * Deterministically maps process exit status, NTSTATUS / POSIX codes, and stream flags
 * into human-readable Chinese/English exit reasons so neither users nor models confuse
 * console interrupts (`0xC000013A`) with timeouts.
 */
export function classifyExitReason(params: {
  executionStatus: ExecutionStatus;
  exitCode: number | null;
  turnCompleted?: boolean;
  turnFailed?: boolean;
  spawnError?: boolean;
  workerCrashed?: boolean;
}): ExitReasonInfo {
  const { executionStatus, exitCode } = params;

  if (executionStatus === 'running') {
    return {
      code: 'running',
      exit_code: null,
      label_zh: '运行中',
      label_en: 'Running',
    };
  }

  if (executionStatus === 'canceled') {
    return {
      code: 'canceled',
      exit_code: exitCode,
      label_zh: '已取消',
      label_en: 'Canceled',
    };
  }

  if (executionStatus === 'timed_out') {
    return {
      code: 'timed_out',
      exit_code: exitCode,
      label_zh: '单轮超时终止',
      label_en: 'Turn timed out',
    };
  }

  if (params.spawnError) {
    return {
      code: 'spawn_error',
      exit_code: exitCode,
      label_zh: 'Codex 启动失败',
      label_en: 'Codex launch failed',
    };
  }

  // Windows STATUS_CONTROL_C_EXIT: 0xC000013A (unsigned 3221225786 / signed -1073741510)
  if (exitCode === 3221225786 || exitCode === -1073741510) {
    return {
      code: 'windows_console_interrupt',
      exit_code: exitCode,
      signal_hex: '0xC000013A',
      label_zh: 'Windows 控制台中断 (0xC000013A)',
      label_en: 'Windows console interrupt (0xC000013A)',
    };
  }

  // POSIX SIGINT (130) or SIGTERM (143)
  if (exitCode === 130 || exitCode === 143) {
    const sigName = exitCode === 130 ? 'SIGINT' : 'SIGTERM';
    return {
      code: 'interrupted',
      exit_code: exitCode,
      signal_hex: sigName,
      label_zh: `信号中断 (${sigName})`,
      label_en: `Interrupted (${sigName})`,
    };
  }

  if (params.workerCrashed || (executionStatus === 'failed' && exitCode === null && !params.turnFailed)) {
    return {
      code: 'worker_crashed',
      exit_code: exitCode,
      label_zh: '后台进程异常中断',
      label_en: 'Worker exited unexpectedly',
    };
  }

  if (params.turnFailed) {
    return {
      code: 'turn_failed',
      exit_code: exitCode,
      label_zh: exitCode !== null ? `模型回合报错 (退出码 ${exitCode})` : '模型回合报错',
      label_en: exitCode !== null ? `Turn failed (exit ${exitCode})` : 'Turn failed',
    };
  }

  if (executionStatus === 'succeeded' && (exitCode === 0 || exitCode === null)) {
    return {
      code: 'normal',
      exit_code: exitCode ?? 0,
      label_zh: '正常退出',
      label_en: 'Exited normally',
    };
  }

  if (exitCode === 0 && params.turnCompleted === false) {
    return {
      code: 'incomplete_stream',
      exit_code: 0,
      label_zh: '事件流未完整结束',
      label_en: 'Stream ended before completion',
    };
  }

  const unsignedHex =
    typeof exitCode === 'number' && (exitCode > 255 || exitCode < 0)
      ? `0x${(exitCode >>> 0).toString(16).toUpperCase()}`
      : null;

  return {
    code: 'non_zero_exit',
    exit_code: exitCode,
    ...(unsignedHex ? { signal_hex: unsignedHex } : {}),
    label_zh:
      exitCode !== null
        ? `异常退出 (${unsignedHex ? `${exitCode} / ${unsignedHex}` : exitCode})`
        : '执行失败',
    label_en:
      exitCode !== null
        ? `Failed (exit ${unsignedHex ? `${exitCode} / ${unsignedHex}` : exitCode})`
        : 'Execution failed',
  };
}
