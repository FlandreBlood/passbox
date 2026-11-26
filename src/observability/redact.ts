const REDACTION_PATTERNS: Array<[RegExp, string]> = [
  [/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}\b/gi, '$1[REDACTED]'],
  [/\b(sk-[A-Za-z0-9_-]{16,})\b/g, '[REDACTED_OPENAI_KEY]'],
  [/\b(gh[pousr]_[A-Za-z0-9]{20,})\b/g, '[REDACTED_GH_TOKEN]'],
  [/\b(AIza[0-9A-Za-z_-]{25,})\b/g, '[REDACTED_API_KEY]'],
  [
    /\b((?:OPENAI_API_KEY|ANTHROPIC_API_KEY|GEMINI_API_KEY|GOOGLE_API_KEY|ANTIGRAVITY_CSRF_TOKEN|GITHUB_TOKEN|ACCESS_TOKEN|REFRESH_TOKEN|BEARER_TOKEN)\s*[=:]\s*)([^\s"'`]+)/gi,
    '$1[REDACTED]',
  ],
  [/("?(?:authorization|x-api-key|x-codeium-csrf-token)"?\s*:\s*")([^"]+)(")/gi, '$1[REDACTED]$3'],
];

export function redactSensitiveText(input: string): string {
  if (!input) return '';
  let out = input;
  for (const [pattern, replacement] of REDACTION_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}
