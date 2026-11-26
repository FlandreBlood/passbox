export declare function resolveCodexBinary(): string;
export declare function unwrapNodeCmdShim(cmdFilePath: string): string | null;
export declare function buildCodexSpawnCommand(binaryPath: string, args: string[], platform?: NodeJS.Platform): {
    cmd: string;
    args: string[];
    windowsVerbatimArguments: boolean;
};
