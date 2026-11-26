import fs from 'node:fs';
import type { ClaimItem, ExecutorFinalReport, ReportedStatus } from '../types.js';
import { redactSensitiveText } from '../observability/redact.js';

/**
 * Strict JSON Schema compatible with OpenAI Structured Outputs (`--output-schema` in Codex CLI).
 * All objects specify `additionalProperties: false` and list every property in `required`.
 */
export const EXECUTOR_OUTPUT_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'blockers', 'counter_evidence'],
  properties: {
    status: {
      type: 'string',
      enum: ['completed', 'partial', 'blocked'],
    },
    blockers: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['claim', 'evidence'],
        properties: {
          claim: { type: 'string' },
          evidence: { type: ['string', 'null'] },
        },
      },
    },
    counter_evidence: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['claim', 'evidence'],
        properties: {
          claim: { type: 'string' },
          evidence: { type: ['string', 'null'] },
        },
      },
    },
  },
} as const;

function normalizeClaimItems(raw: unknown): ClaimItem[] | null {
  if (!Array.isArray(raw)) return null;
  const out: ClaimItem[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') return null;
    const rec = entry as Record<string, unknown>;
    if (typeof rec.claim !== 'string') return null;
    const claim = redactSensitiveText(rec.claim.trim());
    if (!claim) continue;
    const evidence =
      typeof rec.evidence === 'string' && rec.evidence.trim()
        ? redactSensitiveText(rec.evidence.trim())
        : null;
    out.push({ claim, evidence });
  }
  return out;
}

export function parseExecutorReportText(rawText: string | null | undefined): {
  reportedStatus: ReportedStatus;
  report: ExecutorFinalReport | null;
} {
  const trimmed = (rawText ?? '').trim();
  if (!trimmed) {
    return { reportedStatus: 'missing', report: null };
  }

  let candidate = trimmed;
  // Unwrap accidental markdown code fences if a mock or model wrapped JSON
  const fenceMatch = /^```(?:json)?\s*\r?\n([\s\S]*?)\r?\n```$/i.exec(candidate);
  if (fenceMatch) {
    candidate = fenceMatch[1].trim();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return { reportedStatus: 'invalid', report: null };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { reportedStatus: 'invalid', report: null };
  }

  const obj = parsed as Record<string, unknown>;
  if (obj.status !== 'completed' && obj.status !== 'partial' && obj.status !== 'blocked') {
    return { reportedStatus: 'invalid', report: null };
  }

  const blockers = normalizeClaimItems(obj.blockers === undefined ? [] : obj.blockers);
  const counterEvidence = normalizeClaimItems(
    obj.counter_evidence === undefined ? [] : obj.counter_evidence
  );
  if (blockers === null || counterEvidence === null) {
    return { reportedStatus: 'invalid', report: null };
  }

  return {
    reportedStatus: obj.status,
    report: {
      status: obj.status,
      blockers,
      counter_evidence: counterEvidence,
    },
  };
}

export function readAndParseExecutorReport(
  lastMessageFilePath: string,
  fallbackAgentMessage: string | null
): {
  reportedStatus: ReportedStatus;
  report: ExecutorFinalReport | null;
} {
  if (lastMessageFilePath && fs.existsSync(lastMessageFilePath)) {
    try {
      const fileText = fs.readFileSync(lastMessageFilePath, 'utf8');
      if (fileText.trim()) {
        return parseExecutorReportText(fileText);
      }
    } catch {}
  }
  return parseExecutorReportText(fallbackAgentMessage);
}
