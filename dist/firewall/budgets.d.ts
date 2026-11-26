import type { BudgetOptions } from '../types.js';
export interface ResolvedBudgets {
    statusBytes: number;
    summaryBytes: number;
    previewBytes: number;
    previewLines: number;
    recallBytes: number;
    hardMaxBytes: number;
}
export declare const DEFAULT_BUDGETS: ResolvedBudgets;
export declare function resolveBudgets(opts?: BudgetOptions): ResolvedBudgets;
export declare function utf8ByteLength(text: string): number;
/**
 * Maximum JSON-RPC 2.0 MCP envelope overhead around `content[0].text`:
 * `{"jsonrpc":"2.0","id":...,"result":{"isError":true,"content":[{"type":"text","text":"..."}]}}\n`
 */
export declare const MCP_ENVELOPE_OVERHEAD_BYTES = 128;
/**
 * Returns an exact upper-bound byte count of the final serialized MCP JSON-RPC line
 * after `JSON.stringify` escapes the inner tool text into `content[0].text`.
 */
export declare function mcpWireSerializedBytes(innerText: string): number;
export declare function truncateUtf8ByBytes(input: string, maxBytes: number): {
    text: string;
    truncated: boolean;
};
export declare function truncateByBytesAndLines(input: string, maxBytes: number, maxLines: number): {
    text: string;
    truncated: boolean;
    totalLines: number;
    keptLines: number;
};
/**
 * Guarantees that the final wire-serialized MCP JSON-RPC response never exceeds
 * `Math.min(maxBytes, 32 KiB)`.
 */
export declare function serializeWithinBudget(payload: Record<string, unknown>, maxBytes: number, fallbackBuilder: (actualBytes: number, capBytes: number) => Record<string, unknown>): string;
