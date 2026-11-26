import type { CallerMetadata, ExecutionStatus, ExitReasonInfo, ModelSource, ReasoningEffort } from '../types.js';
/**
 * Validates an optional user-supplied model identifier.
 * Rejects leading dashes or whitespace/shell metacharacters so CLI flags cannot be injected.
 */
export declare function validateModelIdentifier(raw: unknown): string | null;
export declare function validateReasoningEffort(raw: unknown): ReasoningEffort | null;
export declare function sanitizeCallerMetadata(raw: unknown): CallerMetadata | null;
export declare function resolveCodexHomeDir(explicitCodexHome?: string): string;
export interface CodexConfigDefaults {
    model: string | null;
    reasoningEffort: string | null;
    profile: string | null;
}
/**
 * Read-only parser for non-secret model defaults in `${CODEX_HOME}/config.toml`.
 * Never reads `auth.json` or mutates any user configuration.
 */
export declare function parseCodexConfigTomlText(tomlText: string): CodexConfigDefaults;
export declare function readCodexConfigDefaults(explicitCodexHome?: string): CodexConfigDefaults;
/**
 * Inspects the first 16 KiB of Codex's native session rollout file (`~/.codex/sessions/...`)
 * for `threadId` to extract the exact runtime `model` and `effort` negotiated by Codex CLI.
 */
export declare function readCodexSessionRolloutModel(threadId: string | null | undefined, explicitCodexHome?: string): {
    model: string | null;
    reasoningEffort: string | null;
};
export declare function resolveEffectiveCodexModel(params: {
    requestedModel?: string | null;
    requestedEffort?: string | null;
    streamModel?: string | null;
    threadId?: string | null;
    codexHome?: string;
}): {
    resolvedModel: string | null;
    modelSource: ModelSource;
    reasoningEffort: string | null;
};
/**
 * Deterministically maps process exit status, NTSTATUS / POSIX codes, and stream flags
 * into human-readable Chinese/English exit reasons so neither users nor models confuse
 * console interrupts (`0xC000013A`) with timeouts.
 */
export declare function classifyExitReason(params: {
    executionStatus: ExecutionStatus;
    exitCode: number | null;
    turnCompleted?: boolean;
    turnFailed?: boolean;
    spawnError?: boolean;
    workerCrashed?: boolean;
}): ExitReasonInfo;
