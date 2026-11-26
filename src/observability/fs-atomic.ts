import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const TRANSIENT_FS_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
const LOCK_CONTENDED_CODES = new Set(['EEXIST', 'ENOTEMPTY', 'EPERM', 'EBUSY', 'EACCES']);
const SAFE_CLEANUP_CODES = new Set(['ENOENT', 'EEXIST', 'ENOTEMPTY', 'EPERM', 'EBUSY', 'EACCES']);

const sleepSyncBuf = new Int32Array(new SharedArrayBuffer(4));

export function sleepSyncMs(ms: number): void {
  Atomics.wait(sleepSyncBuf, 0, 0, Math.max(1, ms));
}

export function isPidAlive(pid: number | null | undefined): boolean {
  if (!Number.isInteger(pid) || (pid as number) <= 1) return false;
  try {
    process.kill(pid as number, 0);
    return true;
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code;
    return code === 'EPERM';
  }
}

export function replaceFileWithRetry(tmpPath: string, destPath: string, maxAttempts = 50): void {
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(tmpPath, destPath);
      return;
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException)?.code ?? '';
      if (!TRANSIENT_FS_CODES.has(code) || attempt >= maxAttempts) {
        try {
          fs.rmSync(tmpPath, { force: true });
        } catch {}
        throw err;
      }
      sleepSyncMs(10);
    }
  }
}

export function writeAtomicText(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`;
  fs.writeFileSync(tmpPath, content, 'utf8');
  replaceFileWithRetry(tmpPath, filePath);
}

export function writeAtomicJson(filePath: string, value: unknown): void {
  writeAtomicText(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export function readTextWithRetry(filePath: string, maxAttempts = 40): string {
  for (let attempt = 0; ; attempt++) {
    try {
      return fs.readFileSync(filePath, 'utf8');
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException)?.code ?? '';
      if (!TRANSIENT_FS_CODES.has(code) || attempt >= maxAttempts) {
        throw err;
      }
      sleepSyncMs(10);
    }
  }
}

export function readJsonWithRetry<T>(filePath: string): T {
  return JSON.parse(readTextWithRetry(filePath)) as T;
}

function tryReapStaleLock(lockDir: string): void {
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(lockDir);
  } catch {
    return;
  }
  if (entries.length !== 1) return;
  const match = /^owner-(\d+)-[a-f0-9-]+$/.exec(entries[0]);
  if (!match) return;
  const ownerPid = Number(match[1]);
  if (ownerPid > 1 && !isPidAlive(ownerPid)) {
    try {
      fs.unlinkSync(path.join(lockDir, entries[0]));
      fs.rmdirSync(lockDir);
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException)?.code ?? '';
      if (!SAFE_CLEANUP_CODES.has(code)) throw err;
    }
  }
}

function releaseLockDir(lockDir: string, ownerToken: string): void {
  const marker = path.join(lockDir, ownerToken);
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      fs.unlinkSync(marker);
      break;
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException)?.code ?? '';
      if (code === 'ENOENT') break;
      if (TRANSIENT_FS_CODES.has(code) && attempt < 4) {
        sleepSyncMs(10);
        continue;
      }
      break;
    }
  }
  try {
    fs.rmdirSync(lockDir);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code ?? '';
    if (!SAFE_CLEANUP_CODES.has(code)) throw err;
  }
}

export function withDirectoryLock<T>(lockDir: string, fn: () => T, timeoutMs = 10000): T {
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
      } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException)?.code ?? '';
        if (!LOCK_CONTENDED_CODES.has(code)) throw err;
        lastCode = code;
      }
      tryReapStaleLock(lockDir);
      if (Date.now() >= deadline) {
        throw new Error(
          `Timed out acquiring Passbox state lock (${lastCode || 'contended'}): ${lockDir}`
        );
      }
      sleepSyncMs(12);
    }
    return fn();
  } finally {
    if (acquired) {
      releaseLockDir(lockDir, ownerToken);
    } else {
      try {
        fs.rmSync(candidateDir, { recursive: true, force: true });
      } catch {}
    }
  }
}

export async function withDirectoryLockAsync<T>(
  lockDir: string,
  fn: () => Promise<T>,
  timeoutMs = 15000
): Promise<T> {
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
      } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException)?.code ?? '';
        if (!LOCK_CONTENDED_CODES.has(code)) throw err;
        lastCode = code;
      }
      tryReapStaleLock(lockDir);
      if (Date.now() >= deadline) {
        throw new Error(
          `Timed out acquiring Passbox state lock (${lastCode || 'contended'}): ${lockDir}`
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 12));
    }
    return await fn();
  } finally {
    if (acquired) {
      releaseLockDir(lockDir, ownerToken);
    } else {
      try {
        fs.rmSync(candidateDir, { recursive: true, force: true });
      } catch {}
    }
  }
}
