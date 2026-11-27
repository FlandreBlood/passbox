const COMMAND_CREDENTIAL_NAME = String.raw `\b(?:[A-Z\d]+_)*(?:API_KEY|SECRET_KEY|PASSWORD|TOKEN)`;
const COMMAND_CREDENTIAL = String.raw `(?:` + COMMAND_CREDENTIAL_NAME +
    String.raw `\s*[=:]\s*|--(?:token|api-key|password)(?:=|[ \t]+))`;
const REDACTION_PATTERNS = [
    // Credential fields and option/value pairs in tool arguments and prompt envelopes.
    [/("(?:[\w-]+[_-])?(?:api[_-]?key|secret(?:[_-]key)?|password|token|authorization)"\s*:\s*")((?:\\.|[^"\\])*)(")/gi, '$1[REDACTED]$3'],
    [/("(?:--token|--api-key|--password)"\s*,\s*")((?:\\.|[^"\\])*)(")/gi, '$1[REDACTED]$3'],
    [/\b(https?:\/\/)[^/\s"'@<>]+:[^/\s"'@<>]+@/gi, '$1[REDACTED]@'],
    [/\b(Authorization\s*:\s*Basic\s+)[A-Za-z\d+/=]+/gi, '$1[REDACTED]'],
    // Both "NAME=value with spaces" and NAME="value with spaces" occur in CLI labels.
    [new RegExp(String.raw `((\\?"|\x27)` + COMMAND_CREDENTIAL + String.raw `)([^\r\n]*?)\2`, 'gi'), '$1[REDACTED]$2'],
    [new RegExp(String.raw `(` + COMMAND_CREDENTIAL + String.raw `)(\\?"|\x27)([^\r\n]*?)\2`, 'gi'), '$1$2[REDACTED]$2'],
    [new RegExp(String.raw `(` + COMMAND_CREDENTIAL + String.raw `)((?:\\[ \t]|\\(?!")|[^\s"\x27\x60;&|\\])+)`, 'gi'), '$1[REDACTED]'],
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
export function redactArgv(argv) {
    return argv.map((arg, i) => {
        if (i && /^(?:--token|--api-key|--password)$/i.test(argv[i - 1]))
            return '[REDACTED]';
        const option = /^(--(?:token|api-key|password)=|(?:[\w]+_)?(?:API_KEY|SECRET_KEY|PASSWORD|TOKEN)=)/i.exec(arg);
        return option ? option[1] + '[REDACTED]' : redactSensitiveText(arg);
    });
}
export function redactSensitiveText(input) {
    if (!input)
        return '';
    let out = input;
    for (const [pattern, replacement] of REDACTION_PATTERNS) {
        out = out.replace(pattern, replacement);
    }
    return out;
}
