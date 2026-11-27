import { redactSensitiveText } from '../observability/redact.js';
export const DEFAULT_BUDGETS = {
    statusBytes: 512,
    summaryBytes: 2 * 1024,
    previewBytes: 12 * 1024,
    previewLines: 300,
    recallBytes: 8 * 1024,
    hardMaxBytes: 32 * 1024,
};
export function resolveBudgets(opts) {
    const hardMaxBytes = Math.max(1024, Math.min(opts?.hard_max_bytes ?? DEFAULT_BUDGETS.hardMaxBytes, DEFAULT_BUDGETS.hardMaxBytes));
    return {
        statusBytes: Math.max(256, Math.min(opts?.status_bytes ?? DEFAULT_BUDGETS.statusBytes, DEFAULT_BUDGETS.statusBytes)),
        summaryBytes: Math.max(512, Math.min(opts?.summary_bytes ?? DEFAULT_BUDGETS.summaryBytes, hardMaxBytes - 512)),
        previewBytes: Math.max(512, Math.min(opts?.preview_bytes ?? DEFAULT_BUDGETS.previewBytes, hardMaxBytes - 2048)),
        previewLines: Math.max(10, Math.min(opts?.preview_lines ?? DEFAULT_BUDGETS.previewLines, 2000)),
        recallBytes: Math.max(512, Math.min(opts?.recall_bytes ?? DEFAULT_BUDGETS.recallBytes, hardMaxBytes)),
        hardMaxBytes,
    };
}
export function utf8ByteLength(text) {
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
export function mcpWireSerializedBytes(innerText) {
    return utf8ByteLength(JSON.stringify(innerText)) + MCP_ENVELOPE_OVERHEAD_BYTES;
}
export function truncateUtf8ByBytes(input, maxBytes) {
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
        }
        else {
            hi = mid - 1;
        }
    }
    return {
        text: lo > 0 ? codepoints.slice(0, lo).join('') : '',
        truncated: true,
    };
}
const ACTIVITY_KINDS = new Set(['phase', 'command', 'tool', 'file_change', 'turn', 'notice']);
const ACTIVITY_STATUSES = new Set(['started', 'completed', 'failed', 'declined', 'canceled', 'info']);
export function sanitizeActivityItem(input) {
    if (!input || typeof input !== 'object')
        return null;
    const { at, kind, label, status } = input;
    if (typeof at !== 'string' || typeof label !== 'string' ||
        !ACTIVITY_KINDS.has(kind) ||
        !ACTIVITY_STATUSES.has(status))
        return null;
    const timestamp = Date.parse(at);
    if (!Number.isFinite(timestamp))
        return null;
    return {
        at: new Date(timestamp).toISOString(),
        kind: kind,
        label: truncateUtf8ByBytes(redactSensitiveText(label).replace(/\s+/g, ' ').trim(), 120).text,
        status: status,
    };
}
export function boundActivitySummary(items = [], previouslyOmitted = 0, maxBytes = DEFAULT_BUDGETS.summaryBytes) {
    const ordered = items.map(sanitizeActivityItem).filter((item) => item !== null)
        .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    const budget = Math.min(maxBytes, DEFAULT_BUDGETS.summaryBytes);
    const emptyBytes = utf8ByteLength(JSON.stringify({ activities: [], omitted_count: 0 })) - 1;
    let start = ordered.length;
    let itemsBytes = 0;
    while (start > 0) {
        const nextBytes = itemsBytes + utf8ByteLength(JSON.stringify(ordered[start - 1])) +
            (start < ordered.length ? 1 : 0);
        if (emptyBytes + nextBytes + String(previouslyOmitted + start - 1).length > budget)
            break;
        itemsBytes = nextBytes;
        start--;
    }
    return { activities: ordered.slice(start), omitted_count: previouslyOmitted + start };
}
export function truncateByBytesAndLines(input, maxBytes, maxLines) {
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
export function serializeWithinBudget(payload, maxBytes, fallbackBuilder) {
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
    const minimal = {
        truncated: true,
        budget_exceeded: true,
        task_id: typeof payload.task_id === 'string' ? payload.task_id.slice(0, 48) : undefined,
        revision: typeof payload.revision === 'number' ? payload.revision : undefined,
        recall_id: typeof payload.recall_id === 'string' ? payload.recall_id.slice(0, 64) : undefined,
    };
    return JSON.stringify(minimal);
}
