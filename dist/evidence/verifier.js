import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { terminateProcessTree } from '../adapters/process-tree.js';
import { buildCleanGitEnv } from './git-snapshot.js';
import { redactSensitiveText } from '../observability/redact.js';
const MAX_VERIFY_LOG_BYTES = 8 * 1024 * 1024;
const EXCERPT_HEAD_LIMIT = 180;
const EXCERPT_TAIL_LIMIT = 360;
function quoteWinCmdArg(value) {
    if (value.length === 0)
        return '""';
    if (!/[\s"&|<>()^%!;,=]/.test(value))
        return value;
    const escaped = value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1');
    return `"${escaped.replaceAll('%', '"^%"')}"`;
}
function resolveExecutableOnPath(cmd) {
    if (path.isAbsolute(cmd) || cmd.includes('/') || cmd.includes('\\')) {
        return cmd;
    }
    if (process.platform !== 'win32')
        return cmd;
    const pathEnv = process.env.PATH ?? '';
    const exts = ['.exe', '.cmd', '.bat', ''];
    for (const rawDir of pathEnv.split(path.delimiter).filter(Boolean)) {
        const dir = rawDir.replace(/^"|"$/g, '');
        for (const ext of exts) {
            const candidate = path.join(dir, `${cmd}${ext}`);
            try {
                if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
                    return candidate;
                }
            }
            catch { }
        }
    }
    return cmd;
}
export function prepareSafeArgvSpawn(argv, platform = process.platform) {
    if (!Array.isArray(argv) || argv.length === 0 || !argv[0]?.trim()) {
        throw new Error('verify_commands entry must contain a non-empty string[] argv.');
    }
    const resolvedBin = resolveExecutableOnPath(argv[0]);
    const rest = argv.slice(1);
    if (/\.(mjs|cjs|js)$/i.test(resolvedBin)) {
        return {
            cmd: process.execPath,
            args: [resolvedBin, ...rest],
            windowsVerbatimArguments: false,
        };
    }
    if (platform === 'win32' && /\.(cmd|bat)$/i.test(resolvedBin)) {
        const cmdLine = [resolvedBin, ...rest].map(quoteWinCmdArg).join(' ');
        return {
            cmd: process.env.ComSpec || 'cmd.exe',
            args: ['/d', '/s', '/c', `"${cmdLine}"`],
            windowsVerbatimArguments: true,
        };
    }
    return { cmd: resolvedBin, args: rest, windowsVerbatimArguments: false };
}
function runSingleVerifyCommand(workspaceRoot, spec, index, options) {
    return new Promise((resolve) => {
        const started = Date.now();
        const timeoutMs = Math.max(1, Math.min(spec.timeout_seconds ?? 120, 1800)) * 1000;
        const targetCwd = spec.cwd_rel
            ? path.resolve(workspaceRoot, spec.cwd_rel)
            : workspaceRoot;
        const relCheck = path.relative(workspaceRoot, targetCwd);
        if (relCheck.startsWith('..') || path.isAbsolute(relCheck)) {
            const msg = `verify_commands[${index}] cwd_rel "${spec.cwd_rel}" escapes workspace.`;
            const fullLogBlock = `=== verify[${index}]: ${JSON.stringify(spec.argv)} ===\nERROR: ${msg}\n`;
            if (options?.logFilePath) {
                try {
                    fs.appendFileSync(options.logFilePath, fullLogBlock, 'utf8');
                }
                catch { }
            }
            resolve({
                result: {
                    index,
                    argv: spec.argv,
                    exit_code: null,
                    timed_out: false,
                    spawn_error: msg,
                    duration_ms: 0,
                    output_excerpt: msg,
                },
                fullLogBlock: options?.logFilePath ? '' : fullLogBlock,
                aborted: false,
                truncated: false,
            });
            return;
        }
        let prepared;
        try {
            prepared = prepareSafeArgvSpawn(spec.argv);
        }
        catch (err) {
            const msg = err.message;
            const fullLogBlock = `=== verify[${index}]: ${JSON.stringify(spec.argv)} ===\nERROR: ${msg}\n`;
            if (options?.logFilePath) {
                try {
                    fs.appendFileSync(options.logFilePath, fullLogBlock, 'utf8');
                }
                catch { }
            }
            resolve({
                result: {
                    index,
                    argv: spec.argv,
                    exit_code: null,
                    timed_out: false,
                    spawn_error: msg,
                    duration_ms: 0,
                    output_excerpt: msg,
                },
                fullLogBlock: options?.logFilePath ? '' : fullLogBlock,
                aborted: false,
                truncated: false,
            });
            return;
        }
        const env = buildCleanGitEnv();
        const logFd = options?.logFilePath ? fs.openSync(options.logFilePath, 'a') : null;
        if (logFd !== null) {
            try {
                fs.writeSync(logFd, Buffer.from(`=== verify[${index}] argv=${JSON.stringify(spec.argv)} ===\n`, 'utf8'));
            }
            catch { }
        }
        const decoder = new StringDecoder('utf8');
        let lineBuf = '';
        let headBuf = '';
        let tailBuf = '';
        let totalBytesSeen = 0;
        let writtenBytes = 0;
        let bodyTruncated = false;
        let inMemoryBody = '';
        let timedOut = false;
        let aborted = false;
        let spawnErr;
        const recordExcerptText = (text) => {
            if (!text)
                return;
            if (headBuf.length < EXCERPT_HEAD_LIMIT + 64) {
                headBuf += text.slice(0, EXCERPT_HEAD_LIMIT + 64 - headBuf.length);
            }
            tailBuf = (tailBuf + text).slice(-(EXCERPT_TAIL_LIMIT + 128));
        };
        const writeOutputChunk = (rawText) => {
            if (!rawText)
                return;
            const redacted = redactSensitiveText(rawText);
            recordExcerptText(redacted);
            const byteLen = Buffer.byteLength(redacted, 'utf8');
            totalBytesSeen += byteLen;
            if (bodyTruncated)
                return;
            const remaining = MAX_VERIFY_LOG_BYTES - writtenBytes;
            if (remaining <= 0) {
                bodyTruncated = true;
                return;
            }
            let toWrite = redacted;
            if (byteLen > remaining) {
                toWrite = Buffer.from(redacted, 'utf8').subarray(0, remaining).toString('utf8');
                bodyTruncated = true;
            }
            writtenBytes += Buffer.byteLength(toWrite, 'utf8');
            if (logFd !== null) {
                try {
                    fs.writeSync(logFd, Buffer.from(toWrite, 'utf8'));
                }
                catch { }
            }
            else {
                inMemoryBody += toWrite;
            }
        };
        const consumeStreamText = (decoded, flushAll = false) => {
            lineBuf += decoded;
            let nlIdx;
            while ((nlIdx = lineBuf.indexOf('\n')) !== -1) {
                const lineWithNl = lineBuf.slice(0, nlIdx + 1);
                lineBuf = lineBuf.slice(nlIdx + 1);
                writeOutputChunk(lineWithNl);
            }
            if (lineBuf.length > 16 * 1024) {
                writeOutputChunk(lineBuf);
                lineBuf = '';
            }
            if (flushAll && lineBuf.length > 0) {
                writeOutputChunk(lineBuf);
                lineBuf = '';
            }
        };
        const child = spawn(prepared.cmd, prepared.args, {
            cwd: targetCwd,
            env,
            detached: process.platform !== 'win32',
            windowsHide: true,
            windowsVerbatimArguments: prepared.windowsVerbatimArguments,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        if (child.pid) {
            options?.onChildSpawned?.(child.pid);
        }
        const appendChunk = (chunk) => {
            consumeStreamText(decoder.write(chunk), false);
        };
        child.stdout?.on('data', appendChunk);
        child.stderr?.on('data', appendChunk);
        let stoppingPromise = null;
        const stopChild = (reason) => {
            if (reason === 'timeout')
                timedOut = true;
            if (reason === 'abort')
                aborted = true;
            if (!stoppingPromise && child.pid) {
                stoppingPromise = terminateProcessTree(child.pid);
            }
        };
        const timer = setTimeout(() => stopChild('timeout'), timeoutMs);
        const onAbort = () => stopChild('abort');
        options?.signal?.addEventListener('abort', onAbort, { once: true });
        if (options?.signal?.aborted) {
            stopChild('abort');
        }
        child.once('error', (err) => {
            spawnErr = err.message;
        });
        child.once('close', (code) => {
            clearTimeout(timer);
            options?.signal?.removeEventListener('abort', onAbort);
            const finishClose = () => {
                options?.onChildSpawned?.(null);
                consumeStreamText(decoder.end(), true);
                const durationMs = Date.now() - started;
                const truncMarker = bodyTruncated
                    ? `\n...[Passbox truncated verification log after ${MAX_VERIFY_LOG_BYTES} bytes; total_output_bytes=${totalBytesSeen}; tail_excerpt=${tailBuf.trim().slice(-240)}]...\n`
                    : '';
                const footer = `\n=== verify[${index}] exit=${code ?? 'null'} timed_out=${timedOut} ` +
                    `aborted=${aborted} duration_ms=${durationMs}${bodyTruncated ? ' truncated=true' : ''} ===\n`;
                if (logFd !== null) {
                    try {
                        if (spawnErr) {
                            fs.writeSync(logFd, Buffer.from(`spawn_error: ${spawnErr}\n`, 'utf8'));
                        }
                        if (truncMarker) {
                            fs.writeSync(logFd, Buffer.from(truncMarker, 'utf8'));
                        }
                        fs.writeSync(logFd, Buffer.from(footer, 'utf8'));
                    }
                    catch { }
                    try {
                        fs.closeSync(logFd);
                    }
                    catch { }
                }
                const cleanHead = headBuf.trim();
                const cleanTail = tailBuf.trim();
                let excerpt;
                if (totalBytesSeen <= EXCERPT_HEAD_LIMIT + EXCERPT_TAIL_LIMIT + 32 && cleanTail.length <= EXCERPT_HEAD_LIMIT + EXCERPT_TAIL_LIMIT + 32) {
                    excerpt = cleanTail;
                }
                else {
                    excerpt = `${cleanHead.slice(0, EXCERPT_HEAD_LIMIT)}\n...\n${cleanTail.slice(-EXCERPT_TAIL_LIMIT)}`;
                }
                if (bodyTruncated) {
                    excerpt = `[truncated after ${MAX_VERIFY_LOG_BYTES}B]\n${excerpt}`;
                }
                const fullLogBlock = logFd !== null
                    ? ''
                    : `=== verify[${index}] argv=${JSON.stringify(spec.argv)} ===\n` +
                        `${spawnErr ? `spawn_error: ${spawnErr}\n` : ''}` +
                        `${inMemoryBody.trimEnd()}\n${truncMarker}${footer}`;
                resolve({
                    result: {
                        index,
                        argv: spec.argv,
                        exit_code: code,
                        timed_out: timedOut,
                        ...(spawnErr ? { spawn_error: spawnErr } : {}),
                        duration_ms: durationMs,
                        output_excerpt: spawnErr ? `${spawnErr}\n${excerpt}`.trim() : excerpt,
                    },
                    fullLogBlock,
                    aborted,
                    truncated: bodyTruncated,
                });
            };
            if (stoppingPromise) {
                void stoppingPromise.finally(finishClose);
            }
            else {
                finishClose();
            }
        });
    });
}
export async function runVerificationCommands(workspaceRoot, commands, options) {
    if (!commands || commands.length === 0) {
        return { status: 'not_run', results: [], combinedLog: '', aborted: false, truncated: false };
    }
    if (options?.logFilePath) {
        fs.mkdirSync(path.dirname(options.logFilePath), { recursive: true });
        fs.writeFileSync(options.logFilePath, '', 'utf8');
    }
    const results = [];
    const logBlocks = [];
    let aborted = Boolean(options?.signal?.aborted);
    let truncated = false;
    for (let i = 0; i < commands.length; i++) {
        if (options?.signal?.aborted) {
            aborted = true;
            break;
        }
        const step = await runSingleVerifyCommand(workspaceRoot, commands[i], i, options);
        results.push(step.result);
        if (step.fullLogBlock)
            logBlocks.push(step.fullLogBlock);
        if (step.truncated)
            truncated = true;
        if (step.aborted || options?.signal?.aborted) {
            aborted = true;
            break;
        }
    }
    let status = 'passed';
    if (aborted) {
        status = 'not_run';
    }
    else if (results.some((r) => r.spawn_error)) {
        status = 'error';
    }
    else if (results.some((r) => r.timed_out)) {
        status = 'timed_out';
    }
    else if (results.some((r) => r.exit_code !== 0)) {
        status = 'failed';
    }
    return {
        status,
        results,
        combinedLog: logBlocks.join('\n'),
        aborted,
        truncated,
    };
}
