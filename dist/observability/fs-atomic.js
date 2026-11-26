import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
const TRANSIENT_FS_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
const LOCK_CONTENDED_CODES = new Set(['EEXIST', 'ENOTEMPTY', 'EPERM', 'EBUSY', 'EACCES']);
const SAFE_CLEANUP_CODES = new Set(['ENOENT', 'EEXIST', 'ENOTEMPTY', 'EPERM', 'EBUSY', 'EACCES']);
const sleepSyncBuf = new Int32Array(new SharedArrayBuffer(4));
export function sleepSyncMs(ms) {
    Atomics.wait(sleepSyncBuf, 0, 0, Math.max(1, ms));
}
export function isPidAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 1)
        return false;
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (err) {
        const code = err?.code;
        return code === 'EPERM';
    }
}
export function replaceFileWithRetry(tmpPath, destPath, maxAttempts = 50) {
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    for (let attempt = 0;; attempt++) {
        try {
            fs.renameSync(tmpPath, destPath);
            return;
        }
        catch (err) {
            const code = err?.code ?? '';
            if (!TRANSIENT_FS_CODES.has(code) || attempt >= maxAttempts) {
                try {
                    fs.rmSync(tmpPath, { force: true });
                }
                catch { }
                throw err;
            }
            sleepSyncMs(10);
        }
    }
}
export function writeAtomicText(filePath, content) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmpPath = `${filePath}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`;
    fs.writeFileSync(tmpPath, content, 'utf8');
    replaceFileWithRetry(tmpPath, filePath);
}
export function writeAtomicJson(filePath, value) {
    writeAtomicText(filePath, `${JSON.stringify(value, null, 2)}\n`);
}
export function readTextWithRetry(filePath, maxAttempts = 40) {
    for (let attempt = 0;; attempt++) {
        try {
            return fs.readFileSync(filePath, 'utf8');
        }
        catch (err) {
            const code = err?.code ?? '';
            if (!TRANSIENT_FS_CODES.has(code) || attempt >= maxAttempts) {
                throw err;
            }
            sleepSyncMs(10);
        }
    }
}
export function readJsonWithRetry(filePath) {
    return JSON.parse(readTextWithRetry(filePath));
}
function tryReapStaleLock(lockDir) {
    let entries = [];
    try {
        entries = fs.readdirSync(lockDir);
    }
    catch {
        return;
    }
    if (entries.length !== 1)
        return;
    const match = /^owner-(\d+)-[a-f0-9-]+$/.exec(entries[0]);
    if (!match)
        return;
    const ownerPid = Number(match[1]);
    if (ownerPid > 1 && !isPidAlive(ownerPid)) {
        try {
            fs.unlinkSync(path.join(lockDir, entries[0]));
            fs.rmdirSync(lockDir);
        }
        catch (err) {
            const code = err?.code ?? '';
            if (!SAFE_CLEANUP_CODES.has(code))
                throw err;
        }
    }
}
function releaseLockDir(lockDir, ownerToken) {
    const marker = path.join(lockDir, ownerToken);
    for (let attempt = 0; attempt < 5; attempt++) {
        try {
            fs.unlinkSync(marker);
            break;
        }
        catch (err) {
            const code = err?.code ?? '';
            if (code === 'ENOENT')
                break;
            if (TRANSIENT_FS_CODES.has(code) && attempt < 4) {
                sleepSyncMs(10);
                continue;
            }
            break;
        }
    }
    try {
        fs.rmdirSync(lockDir);
    }
    catch (err) {
        const code = err?.code ?? '';
        if (!SAFE_CLEANUP_CODES.has(code))
            throw err;
    }
}
export function withDirectoryLock(lockDir, fn, timeoutMs = 10000) {
    fs.mkdirSync(path.dirname(lockDir), { recursive: true });
    const ownerToken = `owner-${process.pid}-${randomUUID()}`;
    const candidateDir = `${lockDir}.${ownerToken}`;
    fs.mkdirSync(candidateDir, { recursive: true });
    fs.writeFileSync(path.join(candidateDir, ownerToken), '', 'utf8');
    const deadline = Date.now() + timeoutMs;
    let acquired = false;
    let lastCode = '';
    try {
        for (;;) {
            try {
                fs.renameSync(candidateDir, lockDir);
                acquired = true;
                break;
            }
            catch (err) {
                const code = err?.code ?? '';
                if (!LOCK_CONTENDED_CODES.has(code))
                    throw err;
                lastCode = code;
            }
            tryReapStaleLock(lockDir);
            if (Date.now() >= deadline) {
                throw new Error(`Timed out acquiring Passbox state lock (${lastCode || 'contended'}): ${lockDir}`);
            }
            sleepSyncMs(12);
        }
        return fn();
    }
    finally {
        if (acquired) {
            releaseLockDir(lockDir, ownerToken);
        }
        else {
            try {
                fs.rmSync(candidateDir, { recursive: true, force: true });
            }
            catch { }
        }
    }
}
export async function withDirectoryLockAsync(lockDir, fn, timeoutMs = 15000) {
    fs.mkdirSync(path.dirname(lockDir), { recursive: true });
    const ownerToken = `owner-${process.pid}-${randomUUID()}`;
    const candidateDir = `${lockDir}.${ownerToken}`;
    fs.mkdirSync(candidateDir, { recursive: true });
    fs.writeFileSync(path.join(candidateDir, ownerToken), '', 'utf8');
    const deadline = Date.now() + timeoutMs;
    let acquired = false;
    let lastCode = '';
    try {
        for (;;) {
            try {
                fs.renameSync(candidateDir, lockDir);
                acquired = true;
                break;
            }
            catch (err) {
                const code = err?.code ?? '';
                if (!LOCK_CONTENDED_CODES.has(code))
                    throw err;
                lastCode = code;
            }
            tryReapStaleLock(lockDir);
            if (Date.now() >= deadline) {
                throw new Error(`Timed out acquiring Passbox state lock (${lastCode || 'contended'}): ${lockDir}`);
            }
            await new Promise((resolve) => setTimeout(resolve, 12));
        }
        return await fn();
    }
    finally {
        if (acquired) {
            releaseLockDir(lockDir, ownerToken);
        }
        else {
            try {
                fs.rmSync(candidateDir, { recursive: true, force: true });
            }
            catch { }
        }
    }
}
