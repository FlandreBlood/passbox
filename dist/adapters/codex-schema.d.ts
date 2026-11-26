import type { ExecutorFinalReport, ReportedStatus } from '../types.js';
/**
 * Strict JSON Schema compatible with OpenAI Structured Outputs (`--output-schema` in Codex CLI).
 * All objects specify `additionalProperties: false` and list every property in `required`.
 */
export declare const EXECUTOR_OUTPUT_JSON_SCHEMA: {
    readonly type: "object";
    readonly additionalProperties: false;
    readonly required: readonly ["status", "blockers", "counter_evidence"];
    readonly properties: {
        readonly status: {
            readonly type: "string";
            readonly enum: readonly ["completed", "partial", "blocked"];
        };
        readonly blockers: {
            readonly type: "array";
            readonly items: {
                readonly type: "object";
                readonly additionalProperties: false;
                readonly required: readonly ["claim", "evidence"];
                readonly properties: {
                    readonly claim: {
                        readonly type: "string";
                    };
                    readonly evidence: {
                        readonly type: readonly ["string", "null"];
                    };
                };
            };
        };
        readonly counter_evidence: {
            readonly type: "array";
            readonly items: {
                readonly type: "object";
                readonly additionalProperties: false;
                readonly required: readonly ["claim", "evidence"];
                readonly properties: {
                    readonly claim: {
                        readonly type: "string";
                    };
                    readonly evidence: {
                        readonly type: readonly ["string", "null"];
                    };
                };
            };
        };
    };
};
export declare function parseExecutorReportText(rawText: string | null | undefined): {
    reportedStatus: ReportedStatus;
    report: ExecutorFinalReport | null;
};
export declare function readAndParseExecutorReport(lastMessageFilePath: string, fallbackAgentMessage: string | null): {
    reportedStatus: ReportedStatus;
    report: ExecutorFinalReport | null;
};
