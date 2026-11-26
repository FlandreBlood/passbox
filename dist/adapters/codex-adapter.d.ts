import type { ExecutionStatus, ExecutorFinalReport, ExitReasonInfo, ModelSource, NativeHarnessEventClaim, ReasoningEffort, ReportedStatus, TokenUsageSummary } from '../types.js';
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
    stderrSummary: string;
}
/**
 * Builds native `codex exec` or `codex exec resume` CLI arguments.
 * Preserves native CODEX_HOME, config.toml, AGENTS.md, skills, plugins, MCP, and sandbox/approval policies.
 * Respects `codex exec resume` flag asymmetry (never passes `-C`, `-s`, or `-a` on resume; cwd is set on child process).
 * Only appends `-m` / `-c model_reasoning_effort=...` when explicitly requested by caller.
 */
export declare function buildCodexExecArgs(params: {
    resumeThreadId: string | null;
    outputSchemaFile: string;
    lastMessageFile: string;
    model?: string | null;
    reasoningEffort?: ReasoningEffort | string | null;
}): string[];
export declare function runNativeCodexTurn(input: CodexAdapterRunInput): Promise<CodexAdapterRunResult>;
