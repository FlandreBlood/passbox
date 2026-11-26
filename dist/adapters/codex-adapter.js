import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { writeAtomicJson, writeAtomicText } from '../observability/fs-atomic.js';
import { redactSensitiveText } from '../observability/redact.js';
import { buildCodexSpawnCommand, resolveCodexBinary } from './codex-binary.js';
import { classifyExitReason, resolveEffectiveCodexModel, validateModelIdentifier, validateReasoningEffort, } from './codex-model.js';
import { EXECUTOR_OUTPUT_JSON_SCHEMA, readAndParseExecutorReport, } from './codex-schema.js';
import { terminateProcessTree } from './process-tree.js';
function buildNativeCodexEnv() {
    const env = { ...process.env };
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
export function buildCodexExecArgs(params) {
    const { resumeThreadId, outputSchemaFile, lastMessageFile } = params;
    const cleanModel = validateModelIdentifier(params.model);
    const cleanEffort = validateReasoningEffort(params.reasoningEffort);
    const modelFlags = [];
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
function inferPhaseFromCodexItem(item) {
    const itemType = String(item.type ?? '');
    if (itemType === 'file_change')
        return 'editing';
    if (itemType === 'agent_message')
        return 'responding';
    if (itemType === 'command_execution') {
        const cmd = String(item.command ?? '');
        if (/\b(test|pytest|vitest|jest|tsc|lint|check|cargo test|go test)\b/i.test(cmd)) {
            return 'verifying';
        }
        return 'investigating';
    }
    if (itemType === 'mcp_tool_call' || itemType === 'web_search')
        return 'investigating';
    return null;
}
function summarizeCodexLiveEvent(ev) {
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
        const errObj = ev.error;
        return `turn.failed: ${String(errObj?.message ?? 'error').slice(0, 110)}`;
    }
    if ((type === 'item.started' || type === 'item.completed') &&
        ev.item &&
        typeof ev.item === 'object') {
        const item = ev.item;
        const itemType = String(item.type ?? '');
        if (itemType === 'command_execution') {
            const cmd = String(item.command ?? '').replace(/\s+/g, ' ').trim();
            if (item.status === 'declined') {
                return `declined cmd: ${cmd.slice(0, 100)}`;
            }
            const prefix = type === 'item.started' ? 'running cmd' : 'ran cmd';
            return `${prefix}: ${cmd.slice(0, 110)}`;
        }
        if (itemType === 'mcp_tool_call') {
            const srv = String(item.server ?? 'mcp');
            const tool = String(item.tool ?? 'call');
            return `${type === 'item.started' ? 'calling' : 'done'} ${srv}.${tool}`;
        }
        if (itemType === 'file_change') {
            const changes = Array.isArray(item.changes) ? item.changes : [];
            const paths = changes
                .map((c) => (c && typeof c === 'object' ? String(c.path ?? '') : ''))
                .filter(Boolean);
            return paths.length > 0
                ? `edited ${paths.slice(0, 2).join(', ')}${paths.length > 2 ? ` (+${paths.length - 2})` : ''}`
                : 'file_change';
        }
        if (itemType === 'web_search') {
            return `web_search: ${String(item.query ?? '').slice(0, 90)}`;
        }
        if (itemType === 'agent_message' && type === 'item.completed') {
            return 'agent_message emitted';
        }
        if (itemType === 'error' && typeof item.message === 'string') {
            return `notice: ${item.message.replace(/\s+/g, ' ').trim().slice(0, 110)}`;
        }
    }
    return null;
}
export async function runNativeCodexTurn(input) {
    const startedAtMs = Date.now();
    const binary = resolveCodexBinary();
    const requestedModel = validateModelIdentifier(input.model);
    const requestedEffort = validateReasoningEffort(input.reasoningEffort);
    writeAtomicJson(input.outputSchemaFile, EXECUTOR_OUTPUT_JSON_SCHEMA);
    try {
        fs.rmSync(input.lastMessageFile, { force: true });
    }
    catch { }
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
    let threadId = input.resumeThreadId;
    let streamModel = null;
    let lastAgentMessage = null;
    let lastEvent = null;
    let turnCompleted = false;
    let turnFailed = false;
    let timedOut = false;
    let canceled = false;
    let usage = null;
    const nativeEvents = [];
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
        if (next.resolvedModel !== currentModelInfo.resolvedModel ||
            next.modelSource !== currentModelInfo.modelSource ||
            next.reasoningEffort !== currentModelInfo.reasoningEffort) {
            currentModelInfo = next;
            input.onModelResolved?.(next);
        }
    };
    const recordNativeEvent = (msg) => {
        const clean = redactSensitiveText(msg.trim());
        if (!clean)
            return;
        if (nativeEvents.length < 8 && !nativeEvents.some((e) => e.message === clean)) {
            nativeEvents.push({ source: 'native_harness_event', message: clean.slice(0, 400) });
        }
    };
    const recordLiveEvent = (rawSummary) => {
        if (!rawSummary)
            return;
        const clean = redactSensitiveText(rawSummary).slice(0, 160);
        if (!clean || clean === lastEvent)
            return;
        lastEvent = clean;
        input.onLiveEvent?.(clean);
    };
    const setPhase = (nextPhase) => {
        if (nextPhase && nextPhase !== currentPhase) {
            currentPhase = nextPhase;
            input.onPhaseChanged?.(nextPhase);
        }
    };
    const handleJsonEvent = (ev) => {
        const type = String(ev.type ?? '');
        if (typeof ev.model === 'string' && ev.model.trim()) {
            streamModel = ev.model.trim().slice(0, 80);
            refreshModelInfo();
        }
        recordLiveEvent(summarizeCodexLiveEvent(ev));
        if (type === 'thread.started' && typeof ev.thread_id === 'string' && ev.thread_id) {
            threadId = ev.thread_id;
            input.onThreadStarted?.(ev.thread_id);
            refreshModelInfo();
            setPhase('investigating');
            return;
        }
        if (type === 'turn.started') {
            refreshModelInfo();
            setPhase('investigating');
            return;
        }
        if (type === 'turn.completed') {
            turnCompleted = true;
            if (ev.usage && typeof ev.usage === 'object') {
                usage = ev.usage;
            }
            return;
        }
        if (type === 'turn.failed') {
            turnFailed = true;
            const errObj = ev.error;
            recordNativeEvent(String(errObj?.message ?? 'Codex turn.failed event'));
            return;
        }
        if (type === 'error') {
            recordNativeEvent(String(ev.message ?? 'Codex stream error'));
            return;
        }
        if ((type === 'item.started' || type === 'item.updated' || type === 'item.completed') &&
            ev.item &&
            typeof ev.item === 'object') {
            const item = ev.item;
            setPhase(inferPhaseFromCodexItem(item));
            if (item.type === 'agent_message' && typeof item.text === 'string') {
                lastAgentMessage = item.text;
            }
            if (item.status === 'declined') {
                recordNativeEvent(`Native approval or sandbox declined ${String(item.type ?? 'operation')}: ${String(item.command ?? item.id ?? '')}`);
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
            child.stdin.on('error', () => { });
            child.stdin.end(input.prompt, 'utf8');
        }
        const decoder = new StringDecoder('utf8');
        let lineBuf = '';
        const writeRedactedTraceLine = (line) => {
            try {
                fs.writeSync(traceFd, Buffer.from(`${redactSensitiveText(line)}\n`, 'utf8'));
            }
            catch { }
        };
        const consumeLines = (chunkStr, flushAll = false) => {
            lineBuf += chunkStr;
            let nlIdx;
            while ((nlIdx = lineBuf.indexOf('\n')) !== -1) {
                const rawLine = lineBuf.slice(0, nlIdx).trim();
                lineBuf = lineBuf.slice(nlIdx + 1);
                if (!rawLine)
                    continue;
                writeRedactedTraceLine(rawLine);
                try {
                    const parsed = JSON.parse(rawLine);
                    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                        handleJsonEvent(parsed);
                    }
                }
                catch { }
            }
            if (flushAll && lineBuf.trim()) {
                const remaining = lineBuf.trim();
                writeRedactedTraceLine(remaining);
                try {
                    const parsed = JSON.parse(remaining);
                    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                        handleJsonEvent(parsed);
                    }
                }
                catch { }
                lineBuf = '';
            }
        };
        const stderrDecoder = new StringDecoder('utf8');
        let stderrLineBuf = '';
        const consumeStderrText = (decoded, flushAll = false) => {
            stderrLineBuf += decoded;
            let nlIdx;
            while ((nlIdx = stderrLineBuf.indexOf('\n')) !== -1) {
                const lineWithNl = stderrLineBuf.slice(0, nlIdx + 1);
                stderrLineBuf = stderrLineBuf.slice(nlIdx + 1);
                const cleanLine = redactSensitiveText(lineWithNl);
                try {
                    fs.writeSync(stderrFd, Buffer.from(cleanLine, 'utf8'));
                }
                catch { }
                stderrTail = (stderrTail + cleanLine).slice(-4096);
            }
            if (flushAll && stderrLineBuf.length > 0) {
                const cleanRem = redactSensitiveText(stderrLineBuf);
                try {
                    fs.writeSync(stderrFd, Buffer.from(cleanRem, 'utf8'));
                }
                catch { }
                stderrTail = (stderrTail + cleanRem).slice(-4096);
                stderrLineBuf = '';
            }
        };
        child.stdout?.on('data', (chunk) => {
            consumeLines(decoder.write(chunk));
        });
        child.stderr?.on('data', (chunk) => {
            consumeStderrText(stderrDecoder.write(chunk));
        });
        let stoppingPromise = null;
        const stopChild = (reason) => {
            if (reason === 'cancel')
                canceled = true;
            if (reason === 'timeout')
                timedOut = true;
            if (!stoppingPromise && child.pid) {
                stoppingPromise = terminateProcessTree(child.pid);
            }
        };
        const onAbort = () => stopChild('cancel');
        input.signal.addEventListener('abort', onAbort, { once: true });
        if (input.signal.aborted)
            stopChild('cancel');
        const timeoutTimer = setTimeout(() => stopChild('timeout'), timeoutMs);
        let spawnError = null;
        const exitCode = await new Promise((resolve) => {
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
            recordNativeEvent(`Failed to launch Codex CLI: ${spawnError.message}`);
        }
        const cleanedStderr = redactSensitiveText(stderrTail
            .split(/\r?\n/)
            .filter((l) => l.trim() && !l.startsWith('WARNING: proceeding, even though we could not update PATH:'))
            .join('\n')
            .trim());
        if (cleanedStderr && (exitCode !== 0 || turnFailed)) {
            recordNativeEvent(cleanedStderr.slice(0, 350));
        }
        const { reportedStatus, report } = readAndParseExecutorReport(input.lastMessageFile, lastAgentMessage);
        if (input.lastMessageFile && fs.existsSync(input.lastMessageFile)) {
            try {
                const rawLastMsg = fs.readFileSync(input.lastMessageFile, 'utf8');
                const redactedLastMsg = redactSensitiveText(rawLastMsg);
                if (redactedLastMsg !== rawLastMsg) {
                    writeAtomicText(input.lastMessageFile, redactedLastMsg);
                }
            }
            catch { }
        }
        let executionStatus;
        if (canceled) {
            executionStatus = 'canceled';
        }
        else if (timedOut) {
            executionStatus = 'timed_out';
        }
        else if (spawnError || turnFailed || exitCode !== 0 || !turnCompleted) {
            executionStatus = 'failed';
        }
        else {
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
            stderrSummary: cleanedStderr.slice(0, 600),
        };
    }
    finally {
        try {
            fs.closeSync(traceFd);
        }
        catch { }
        try {
            fs.closeSync(stderrFd);
        }
        catch { }
    }
}
