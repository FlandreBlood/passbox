import type { VerificationStatus, VerifyCommandResult, VerifyCommandSpec } from '../types.js';
export interface VerificationRunOptions {
    signal?: AbortSignal;
    onChildSpawned?: (pid: number | null) => void;
    logFilePath?: string;
}
export declare function prepareSafeArgvSpawn(argv: string[], platform?: NodeJS.Platform): {
    cmd: string;
    args: string[];
    windowsVerbatimArguments: boolean;
};
export declare function runVerificationCommands(workspaceRoot: string, commands?: VerifyCommandSpec[], options?: VerificationRunOptions): Promise<{
    status: VerificationStatus;
    results: VerifyCommandResult[];
    combinedLog: string;
    aborted: boolean;
    truncated: boolean;
}>;
