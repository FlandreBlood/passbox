#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

export interface FakeCodexStepBehavior {
  delay_ms?: number;
  events?: Record<string, unknown>[];
  events_after_delay?: Record<string, unknown>[];
  hang_ms?: number;
  spawn_sleeper_pid_file?: string;
  write_files?: Record<string, string>;
  write_binary_files?: Record<string, number[]>;
  delete_files?: string[];
  emit_chatter?: string;
  report_mode?: 'valid' | 'missing' | 'invalid_json' | 'invalid_schema';
  report?: {
    status: 'completed' | 'partial' | 'blocked';
    blockers?: Array<{ claim: string; evidence?: string | null }>;
    counter_evidence?: Array<{ claim: string; evidence?: string | null }>;
  };
  turn_failed?: string;
  approval_declined?: string;
  exit_code?: number;
  stderr?: string;
}

export interface FakeCodexScenarioFile {
  steps: FakeCodexStepBehavior[];
}

function validateStrictOpenAiOutputSchema(schemaObj: Record<string, unknown>, where = 'root'): void {
  if (schemaObj.type === 'object') {
    if (schemaObj.additionalProperties !== false) {
      throw new Error(`Schema at ${where} missing additionalProperties: false`);
    }
    const props = (schemaObj.properties ?? {}) as Record<string, Record<string, unknown>>;
    const req = Array.isArray(schemaObj.required) ? (schemaObj.required as string[]) : [];
    for (const key of Object.keys(props)) {
      if (!req.includes(key)) {
        throw new Error(`Schema at ${where} property "${key}" missing from required[]`);
      }
      validateStrictOpenAiOutputSchema(props[key], `${where}.${key}`);
    }
  } else if (schemaObj.type === 'array' && schemaObj.items && typeof schemaObj.items === 'object') {
    validateStrictOpenAiOutputSchema(schemaObj.items as Record<string, unknown>, `${where}[]`);
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes('--version') || argv.includes('-V')) {
    process.stdout.write('codex-cli 0.172.0-fake\n');
    process.exit(0);
  }

  // Enforce non-leakage of temporary GIT_INDEX_FILE into Codex execution environment
  if (process.env.GIT_INDEX_FILE) {
    process.stderr.write(`FATAL: GIT_INDEX_FILE leaked into codex env: ${process.env.GIT_INDEX_FILE}\n`);
    process.exit(99);
  }

  if (argv[0] !== 'exec') {
    process.stderr.write(`fake-codex: unsupported subcommand "${argv[0] ?? ''}"\n`);
    process.exit(2);
  }

  const isResume = argv[1] === 'resume';
  const rest = isResume ? argv.slice(2) : argv.slice(1);

  // Enforce real Codex 0.172.0 CLI asymmetry: `codex exec resume` rejects -C, -s, -a!
  if (isResume) {
    for (const forbidden of ['-C', '--cd', '-s', '--sandbox', '-a', '--ask-for-approval']) {
      if (rest.includes(forbidden)) {
        process.stderr.write(`error: unexpected argument '${forbidden}' found in codex exec resume\n`);
        process.exit(2);
      }
    }
  }

  let outputSchemaPath = '';
  let lastMessagePath = '';
  let modelArg: string | null = null;
  const configArgs: string[] = [];
  let jsonMode = false;
  const positionals: string[] = [];

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '--json') {
      jsonMode = true;
      continue;
    }
    if (arg === '--output-schema') {
      outputSchemaPath = rest[++i] ?? '';
      continue;
    }
    if (arg === '-o' || arg === '--output-last-message') {
      lastMessagePath = rest[++i] ?? '';
      continue;
    }
    if (arg === '-m' || arg === '--model') {
      modelArg = rest[++i] ?? null;
      continue;
    }
    if (arg === '-c' || arg === '--config') {
      configArgs.push(rest[++i] ?? '');
      continue;
    }
    positionals.push(arg);
  }

  if (!jsonMode) {
    process.stderr.write('fake-codex: expected --json\n');
    process.exit(2);
  }

  if (outputSchemaPath) {
    const schemaJson = JSON.parse(fs.readFileSync(outputSchemaPath, 'utf8')) as Record<string, unknown>;
    validateStrictOpenAiOutputSchema(schemaJson);
  }

  let threadId: string;
  let promptArg: string;
  if (isResume) {
    threadId = positionals[0] || '';
    promptArg = positionals[1] || '-';
    if (!threadId || threadId === '-') {
      process.stderr.write('fake-codex: resume missing SESSION_ID\n');
      process.exit(2);
    }
  } else {
    threadId = `thread_${randomUUID().slice(0, 8)}`;
    promptArg = positionals[0] || '-';
  }

  const promptText = promptArg === '-' ? fs.readFileSync(0, 'utf8') : promptArg;
  const workspace = process.cwd();

  // Load scenario state from PASSBOX_FAKE_CODEX_STATE_DIR
  const stateDir = process.env.PASSBOX_FAKE_CODEX_STATE_DIR || '';
  let step: FakeCodexStepBehavior = {
    report_mode: 'valid',
    report: { status: 'completed', blockers: [], counter_evidence: [] },
  };
  let callIndex = 0;

  if (stateDir) {
    fs.mkdirSync(stateDir, { recursive: true });
    const counterFile = path.join(stateDir, 'call-count.txt');
    if (fs.existsSync(counterFile)) {
      callIndex = Number(fs.readFileSync(counterFile, 'utf8').trim()) || 0;
    }
    fs.writeFileSync(counterFile, `${callIndex + 1}\n`, 'utf8');
    fs.writeFileSync(
      path.join(stateDir, `call-${callIndex}.json`),
      JSON.stringify({ isResume, threadId, workspace, promptText, modelArg, configArgs }, null, 2),
      'utf8'
    );

    const scenarioFile = path.join(stateDir, 'scenario.json');
    if (fs.existsSync(scenarioFile)) {
      const scenario = JSON.parse(fs.readFileSync(scenarioFile, 'utf8')) as FakeCodexScenarioFile;
      step = scenario.steps[Math.min(callIndex, scenario.steps.length - 1)] ?? step;
    }
  }

  const emit = (obj: Record<string, unknown>) => {
    process.stdout.write(`${JSON.stringify(obj)}\n`);
  };

  emit({ type: 'thread.started', thread_id: threadId });
  emit({ type: 'turn.started' });
  for (const event of step.events ?? []) emit(event);

  if (step.stderr) {
    process.stderr.write(`${step.stderr}\n`);
  }

  if (step.spawn_sleeper_pid_file) {
    const sleeper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    if (sleeper.pid) {
      fs.writeFileSync(step.spawn_sleeper_pid_file, `${sleeper.pid}\n`, 'utf8');
    }
  }

  // Apply workspace edits BEFORE optional hang/failure so partial edits on cancel/crash are testable!
  if (step.write_files) {
    for (const [rel, content] of Object.entries(step.write_files)) {
      const target = path.join(workspace, rel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content, 'utf8');
    }
    emit({
      type: 'item.completed',
      item: {
        id: 'item_edit_1',
        type: 'file_change',
        status: 'completed',
        changes: Object.keys(step.write_files).map((p) => ({ path: p, kind: 'edit' })),
      },
    });
  }

  if (step.write_binary_files) {
    for (const [rel, bytes] of Object.entries(step.write_binary_files)) {
      const target = path.join(workspace, rel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, Buffer.from(bytes));
    }
  }

  if (step.delete_files) {
    for (const rel of step.delete_files) {
      fs.rmSync(path.join(workspace, rel), { force: true });
    }
  }

  if (step.emit_chatter) {
    emit({
      type: 'item.completed',
      item: {
        id: 'item_chatter_1',
        type: 'agent_message',
        status: 'completed',
        text: step.emit_chatter,
      },
    });
  }

  if (step.approval_declined) {
    emit({
      type: 'item.completed',
      item: {
        id: 'item_declined_1',
        type: 'command_execution',
        command: step.approval_declined,
        status: 'declined',
      },
    });
  }

  if (step.delay_ms && step.delay_ms > 0) {
    await new Promise((r) => setTimeout(r, step.delay_ms));
  }

  for (const event of step.events_after_delay ?? []) emit(event);

  if (step.hang_ms && step.hang_ms > 0) {
    await new Promise((r) => setTimeout(r, step.hang_ms));
  }

  if (step.turn_failed) {
    emit({
      type: 'turn.failed',
      error: { message: step.turn_failed },
    });
    process.exit(step.exit_code ?? 1);
  }

  const mode = step.report_mode ?? 'valid';
  let finalMessageText = '';
  if (mode === 'valid') {
    const rep = step.report ?? { status: 'completed', blockers: [], counter_evidence: [] };
    finalMessageText = JSON.stringify({
      status: rep.status,
      blockers: (rep.blockers ?? []).map((b) => ({ claim: b.claim, evidence: b.evidence ?? null })),
      counter_evidence: (rep.counter_evidence ?? []).map((c) => ({
        claim: c.claim,
        evidence: c.evidence ?? null,
      })),
    });
  } else if (mode === 'invalid_json') {
    finalMessageText = 'I think everything is fixed! Not JSON at all.';
  } else if (mode === 'invalid_schema') {
    finalMessageText = JSON.stringify({ status: 'unknown_status_value' });
  }

  if (finalMessageText) {
    if (lastMessagePath) {
      fs.writeFileSync(lastMessagePath, finalMessageText, 'utf8');
    }
    emit({
      type: 'item.completed',
      item: {
        id: 'item_final_msg',
        type: 'agent_message',
        status: 'completed',
        text: finalMessageText,
      },
    });
  }

  if ((step.exit_code ?? 0) === 0) {
    emit({
      type: 'turn.completed',
      usage: {
        input_tokens: 120,
        cached_input_tokens: 40,
        output_tokens: 35,
        reasoning_output_tokens: 15,
      },
    });
  }

  process.exit(step.exit_code ?? 0);
}

void main();
