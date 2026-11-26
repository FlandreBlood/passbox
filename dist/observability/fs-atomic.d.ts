export declare function sleepSyncMs(ms: number): void;
export declare function isPidAlive(pid: number | null | undefined): boolean;
export declare function replaceFileWithRetry(tmpPath: string, destPath: string, maxAttempts?: number): void;
export declare function writeAtomicText(filePath: string, content: string): void;
export declare function writeAtomicJson(filePath: string, value: unknown): void;
export declare function readTextWithRetry(filePath: string, maxAttempts?: number): string;
export declare function readJsonWithRetry<T>(filePath: string): T;
export declare function withDirectoryLock<T>(lockDir: string, fn: () => T, timeoutMs?: number): T;
export declare function withDirectoryLockAsync<T>(lockDir: string, fn: () => Promise<T>, timeoutMs?: number): Promise<T>;
