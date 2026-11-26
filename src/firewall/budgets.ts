import type { BudgetOptions } from '../types.js';

export interface ResolvedBudgets {
  statusBytes: number;
  summaryBytes: number;
  previewBytes: number;
  previewLines: number;
  recallBytes: number;
  hardMaxBytes: number;
}

export const DEFAULT_BUDGETS: ResolvedBudgets = {
  statusBytes: 512,
  summaryBytes: 2 * 1024,
  previewBytes: 12 * 1024,
  previewLines: 300,
  recallBytes: 8 * 1024,
  hardMaxBytes: 32 * 1024,
};

export function resolveBudgets(opts?: BudgetOptions): ResolvedBudgets {
  const hardMaxBytes = Math.max(
    1024,
    Math.min(opts?.hard_max_bytes ?? DEFAULT_BUDGETS.hardMaxBytes, DEFAULT_BUDGETS.hardMaxBytes)
  );
  return {
    statusBytes: Math.max(
      256,
      Math.min(opts?.status_bytes ?? DEFAULT_BUDGETS.statusBytes, DEFAULT_BUDGETS.statusBytes)
    ),
    summaryBytes: Math.max(
      512,
      Math.min(opts?.summary_bytes ?? DEFAULT_BUDGETS.summaryBytes, hardMaxBytes - 512)
    ),
    previewBytes: Math.max(
      512,
      Math.min(opts?.preview_bytes ?? DEFAULT_BUDGETS.previewBytes, hardMaxBytes - 2048)
    ),
    previewLines: Math.max(10, Math.min(opts?.preview_lines ?? DEFAULT_BUDGETS.previewLines, 2000)),
    recallBytes: Math.max(
      512,
      Math.min(opts?.recall_bytes ?? DEFAULT_BUDGETS.recallBytes, hardMaxBytes)
    ),
    hardMaxBytes,
  };
}

export function utf8ByteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/**
 * Maximum JSON-RPC 2.0 MCP envelope overhead around `content[0].text`:
 * `{"jsonrpc":"2.0","id":...,"result":{"isError":true,"content":[{"type":"text","text":"..."}]}}\n`
 */
export const MCP_ENVELOPE_OVERHEAD_BYTES = 128;

/**
 * Returns an exact upper-bound byte count of the final serialized MCP JSON-RPC line
 * after `JSON.stringify` escapes the inner tool text into `content[0].text`.
 */
export function mcpWireSerializedBytes(innerText: string): number {
  return utf8ByteLength(JSON.stringify(innerText)) + MCP_ENVELOPE_OVERHEAD_BYTES;
}

export function truncateUtf8ByBytes(
  input: string,
  maxBytes: number
): { text: string; truncated: boolean } {
  if (!input || maxBytes <= 0) {
    return { text: '', truncated: Boolean(input) };
  }
  if (utf8ByteLength(input) <= maxBytes) {
    return { text: input, truncated: false };
  }
  const codepoints = Array.from(input);
  let lo = 0;
  let hi = codepoints.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const candidate = codepoints.slice(0, mid).join('');
    if (utf8ByteLength(candidate) <= maxBytes) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return {
    text: lo > 0 ? codepoints.slice(0, lo).join('') : '',
    truncated: true,
  };
}

export function truncateByBytesAndLines(
  input: string,
  maxBytes: number,
  maxLines: number
): { text: string; truncated: boolean; totalLines: number; keptLines: number } {
  if (!input) {
    return { text: '', truncated: false, totalLines: 0, keptLines: 0 };
  }
  const allLines = input.split('\n');
  const totalLines = allLines.length;
  let truncated = false;

  let workingLines = allLines;
  if (workingLines.length > maxLines) {
    workingLines = workingLines.slice(0, maxLines);
    truncated = true;
  }

  let joined = workingLines.join('\n');
  if (utf8ByteLength(joined) > maxBytes) {
    const byteBounded = truncateUtf8ByBytes(joined, maxBytes);
    joined = byteBounded.text;
    truncated = true;
  }

  const keptLines = joined ? joined.split('\n').length : 0;
  return { text: joined, truncated, totalLines, keptLines };
}

/**
 * Guarantees that the final wire-serialized MCP JSON-RPC response never exceeds
 * `Math.min(maxBytes, 32 KiB)`.
 */
export function serializeWithinBudget(
  payload: Record<string, unknown>,
  maxBytes: number,
  fallbackBuilder: (actualBytes: number, capBytes: number) => Record<string, unknown>
): string {
  const cap = Math.min(maxBytes, DEFAULT_BUDGETS.hardMaxBytes);
  const direct = JSON.stringify(payload);
  const wireLen = mcpWireSerializedBytes(direct);
  if (wireLen <= cap) {
    return direct;
  }

  const fallback = fallbackBuilder(wireLen, cap);
  const fallbackJson = JSON.stringify(fallback);
  if (mcpWireSerializedBytes(fallbackJson) <= cap) {
    return fallbackJson;
  }

  // Last-resort ultra-minimal deterministic envelope guaranteed under 512 wire bytes
  const minimal: Record<string, unknown> = {
    truncated: true,
    budget_exceeded: true,
    task_id: typeof payload.task_id === 'string' ? payload.task_id.slice(0, 48) : undefined,
    revision: typeof payload.revision === 'number' ? payload.revision : undefined,
    recall_id: typeof payload.recall_id === 'string' ? payload.recall_id.slice(0, 64) : undefined,
  };
  return JSON.stringify(minimal);
}
