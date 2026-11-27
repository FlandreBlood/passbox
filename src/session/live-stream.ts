import fs from 'node:fs';
import path from 'node:path';
import { parseExecutorReportText } from '../adapters/codex-schema.js';
import { truncateUtf8ByBytes } from '../firewall/budgets.js';
import type { ArchiveStore } from '../observability/archive-store.js';
import { redactArgv, redactSensitiveText } from '../observability/redact.js';
import type { ExecutorFinalReport, RevisionMetadata, RunRecord } from '../types.js';
import { resolveWorkspaceFileLink, type BoardFileLink } from './board-links.js';

export interface LiveEntry {
  key: string;
  kind: string;
  status: 'running' | 'completed' | 'failed' | 'declined' | 'canceled' | 'info';
  at: string | null;
  updated_at?: string;
  duration_ms?: number;
  text: string;
  command?: string;
  exit_code?: number | null;
  aggregated_output?: string;
  arguments?: string;
  result?: string;
  error?: string;
  files?: Array<{ path: string; file_link: BoardFileLink | null }>;
  report?: ExecutorFinalReport & { verified: false };
  truncated?: boolean;
}

export interface LiveStream {
  trust: 'untrusted_artifact_data';
  entries: LiveEntry[];
  omitted_count: number;
  truncated: boolean;
  stderr_tail: string;
  stderr_truncated: boolean;
}

// Work on complete records so a credential prefix or item id is never lost
// when the seek lands inside a long command, JSON string or diagnostic.
function readTail(file: string, bytes: number, minSuffixBytes = 1) {
  if (!fs.existsSync(file)) return { text: '', offset: 0 };
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const buffer = Buffer.alloc(Math.min(bytes, size));
    let offset = size - buffer.length;
    const read = fs.readSync(fd, buffer, 0, buffer.length, offset);
    const end = buffer.subarray(0, read);
    const newline = end.indexOf(10);
    if (offset && newline >= 0 && read - newline - 1 >= minSuffixBytes) {
      return { text: end.toString('utf8', newline + 1), offset: offset + newline + 1 };
    }
    // A single event can exceed the normal read window. Recover its beginning
    // before parsing and redacting, then apply the normal output budgets.
    const chunks = [end];
    while (offset > 0) {
      const chunk = Buffer.alloc(Math.min(64 * 1024, offset));
      offset -= chunk.length;
      fs.readSync(fd, chunk, 0, chunk.length, offset);
      const start = chunk.lastIndexOf(10) + 1;
      chunks.push(chunk.subarray(start));
      if (start) { offset += start; break; }
    }
    return { text: Buffer.concat(chunks.reverse()).toString('utf8'), offset };
  } finally {
    fs.closeSync(fd);
  }
}

function safeText(value: unknown, bytes = 4096, tail = false, entry?: LiveEntry): string {
  if (value == null) return '';
  const clean = redactSensitiveText(typeof value === 'string' ? value : JSON.stringify(value, (_key, val) =>
    typeof val === 'string' ? redactSensitiveText(val) : val));
  if (Buffer.byteLength(clean) <= bytes) return clean;
  if (entry) entry.truncated = true;
  if (tail) {
    const buf = Buffer.from(clean);
    let start = buf.length - bytes;
    while ((buf[start] & 0xc0) === 0x80) start++;
    return buf.toString('utf8', start);
  }
  return truncateUtf8ByBytes(clean, bytes).text;
}

type Fields = Record<string, unknown>;
function eventStatus(event: string, item: Fields, kind: string): LiveEntry['status'] {
  if (item.status === 'declined') return 'declined';
  if (item.status === 'canceled' || item.status === 'cancelled') return 'canceled';
  if (item.error || item.status === 'failed' || event.endsWith('.failed') || kind === 'error' ||
      (typeof item.exit_code === 'number' && item.exit_code !== 0)) return 'failed';
  if (event.endsWith('.completed') || item.status === 'completed') return 'completed';
  if (/\.(started|updated)$/.test(event)) return 'running';
  return 'info';
}

const fields = (value: unknown): Fields =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Fields : {};

export function readLiveStream(
  archive: ArchiveStore, taskId: string, workspace: string,
  run: Pick<RunRecord, 'run_id' | 'published_revision' | 'started_at' | 'finished_at'>, meta?: RevisionMetadata
): LiveStream {
  const paths = archive.runPaths(taskId, run.run_id);
  const traceFile = !fs.existsSync(paths.rawTraceFile) && run.published_revision != null
    ? path.join(archive.revisionDir(taskId, run.published_revision), 'raw_trace.jsonl')
    : paths.rawTraceFile;
  const trace = readTail(traceFile, 2 * 1024 * 1024);
  const activities = fs.existsSync(paths.activitiesFile)
    ? archive.readRunActivities(taskId, run.run_id) : meta?.activities ?? [];
  // Native events often omit wall-clock time. Pair the metadata emitted by
  // the same adapter callback with its trace occurrence when available.
  const times = new Map<string, string[]>();
  for (const a of activities) {
    if (a.kind === 'phase' || a.label.startsWith('verify[')) continue;
    const key = a.kind + '/' + a.status;
    const bucket = times.get(key) ?? [];
    bucket.push(a.at);
    times.set(key, bucket);
  }
  const timeline = new Map<string, LiveEntry>();
  let offset = trace.offset;
  for (const line of trace.text.split('\n')) {
    const position = offset;
    offset += Buffer.byteLength(line) + 1;
    if (!line.trim()) continue;
    let ev: Fields;
    try { ev = fields(JSON.parse(line)); } catch { continue; } // Partial concurrent append.
    const item = ev.item ? fields(ev.item) : ev;
    const event = String(ev.type ?? '');
    const key = typeof item.id === 'string' ? 'item:' + safeText(item.id, 128) : 'trace:' + position;
    const previous = timeline.get(key);
    const kind = String(event.startsWith('turn.') ? 'turn' : item.type ?? previous?.kind ?? event);
    if (!['reasoning', 'command_execution', 'mcp_tool_call', 'web_search', 'collab_tool_call',
      'file_change', 'agent_message', 'turn', 'phase', 'error'].includes(kind)) continue;
    const status = eventStatus(event, item, kind);
    const activityKind = ({ command_execution: 'command', mcp_tool_call: 'tool', web_search: 'tool',
      agent_message: 'notice', error: 'notice' } as Record<string, string>)[kind] ?? kind;
    const observed = !trace.offset && event !== 'item.updated' &&
      !(kind === 'agent_message' && status !== 'completed')
      ? times.get(activityKind + '/' + (status === 'running' ? 'started' : status))?.shift() : null;
    const stamp = ev.timestamp ?? item.timestamp ?? ev.at ?? observed;
    const at = typeof stamp === 'string' && Number.isFinite(Date.parse(stamp))
      ? new Date(stamp).toISOString() : null;
    const entry: LiveEntry = { key, kind, text: kind, ...previous, status, at: previous?.at ?? at };
    if (at) entry.updated_at = at;
    if (typeof item.duration_ms === 'number') entry.duration_ms = item.duration_ms;
    else if (previous?.at && at) entry.duration_ms = Math.max(0, Date.parse(at) - Date.parse(previous.at));
    if (kind === 'command_execution') {
      if (item.command != null) entry.command = entry.text = safeText(item.command, 4096, false, entry);
      if (typeof item.exit_code === 'number') entry.exit_code = item.exit_code;
      const output = item.aggregated_output ?? item.output;
      if (output != null) entry.aggregated_output = safeText(output, 4096, true, entry);
    } else if (kind === 'mcp_tool_call' || kind === 'collab_tool_call') {
      if (item.tool) entry.text = safeText([item.server, item.tool].filter(Boolean).join('.'), 256);
      const args = item.arguments ?? item.prompt;
      if (args != null) entry.arguments = safeText(args, 2048, false, entry);
      const result = item.result ?? item.agents_states ?? item.agent_statuses;
      if (result != null) entry.result = safeText(result, 2048, false, entry);
    } else if (kind === 'file_change' && Array.isArray(item.changes)) {
      entry.files = item.changes.slice(0, 20).map(change => {
        const raw = fields(change).path;
        const name = safeText(raw, 512);
        return { path: name, file_link: raw === name ? resolveWorkspaceFileLink(workspace, name) : null };
      });
      entry.truncated = item.changes.length > entry.files.length;
    } else {
      const value = item.text ?? item.query ?? item.summary ?? item.message ?? ev.text ?? ev.summary ?? ev.message ?? ev.error;
      if (value != null) entry.text = safeText(value, 4096, false, entry);
      else if (kind === 'turn') entry.text = event;
      if (kind === 'agent_message' && typeof item.text === 'string') {
        const { report } = parseExecutorReportText(item.text);
        if (report) {
          const claims = (list: typeof report.blockers) => list.slice(0, 5).map(c => ({
            claim: safeText(c.claim, 384), evidence: c.evidence && safeText(c.evidence, 192),
          }));
          entry.report = { verified: false, status: report.status, blockers: claims(report.blockers), counter_evidence: claims(report.counter_evidence) };
          entry.truncated ||= report.blockers.length > 5 || report.counter_evidence.length > 5;
        }
      }
    }
    if (item.error) entry.error = safeText(item.error, 2048, false, entry);
    // File references are never shortened into a different clickable URI.
    // Even deeply escaped paths and URIs must fit the per-item wire budget.
    while (entry.files?.length && Buffer.byteLength(JSON.stringify(entry)) > 16 * 1024) {
      entry.files.pop();
      entry.truncated = true;
    }
    timeline.set(key, entry);
  }

  for (const [index, a] of activities.entries()) {
    const verify = /^verify\[(\d+)\]:/.exec(a.label);
    if (!verify && a.kind !== 'phase') continue;
    const key = verify ? 'verify:' + verify[1] : 'phase:' + index;
    timeline.set(key, { key, kind: verify ? 'verify' : 'phase', text: a.label,
      status: a.status === 'started' ? 'running' : a.status, at: timeline.get(key)?.at ?? a.at });
  }
  for (const v of meta?.verify_results ?? []) {
    const key = 'verify:' + v.index;
    const command = safeText(redactArgv(v.argv).join(' '));
    timeline.set(key, { key, kind: 'verify', text: command, command, at: timeline.get(key)?.at ?? run.finished_at,
      status: v.exit_code === 0 && !v.timed_out ? 'completed' : 'failed', exit_code: v.exit_code,
      duration_ms: v.duration_ms, aggregated_output: safeText(v.output_excerpt, 4096, true) });
  }
  if (!meta?.verify_results?.length) {
    const verify = readTail(paths.verifyLogFile, 64 * 1024, 4096);
    if (verify.text) timeline.set('verify:log', { key: 'verify:log', kind: 'verify', text: 'verify.log',
      status: 'info', at: run.finished_at, aggregated_output: safeText(verify.text, 4096, true) });
  }
  // Anchor undated native records in trace order, without inventing timestamps.
  let lastTime = Date.parse(run.started_at);
  const ordered = Array.from(timeline.values(), entry => {
    if (entry.updated_at || entry.at) lastTime = Date.parse(entry.updated_at ?? entry.at!);
    return { entry, time: lastTime };
  }).sort((a, b) => a.time - b.time);
  const entries: LiveEntry[] = [];
  let bytes = 0;
  for (let i = ordered.length - 1; i >= 0 && entries.length < 120; i--) {
    const entry = ordered[i].entry;
    // Control characters can take six wire bytes per input byte. Rebound
    // the exceptional entry before accounting for it in the stream.
    if (Buffer.byteLength(JSON.stringify(entry)) > 16 * 1024) {
      entry.truncated = true;
      for (const field of ['text', 'command', 'arguments', 'error', 'result', 'aggregated_output'] as const) {
        if (entry[field]) entry[field] = safeText(entry[field], 384, field === 'aggregated_output');
      }
      if (entry.report) {
        entry.report.blockers = entry.report.blockers.slice(0, 1);
        entry.report.counter_evidence = entry.report.counter_evidence.slice(0, 1);
      }
    }
    bytes += Buffer.byteLength(JSON.stringify(entry)) + 1;
    if (bytes > 92 * 1024) break;
    entries.push(entry);
  }
  const stderr = readTail(paths.stderrFile, 64 * 1024, 4096);
  const stderr_tail = safeText(stderr.text, 4096, true);
  const omitted_count = ordered.length - entries.length;
  return { trust: 'untrusted_artifact_data', entries: entries.reverse(), omitted_count, truncated: Boolean(trace.offset || omitted_count || entries.some(entry => entry.truncated)),
    stderr_tail, stderr_truncated: Boolean(stderr.offset || Buffer.byteLength(redactSensitiveText(stderr.text)) > 4096) };
}
