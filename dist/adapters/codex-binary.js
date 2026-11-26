import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
function isExecutableCandidate(filePath) {
    if (!filePath)
        return false;
    try {
        const st = fs.statSync(filePath);
        if (!st.isFile())
            return false;
        if (/\.(mjs|cjs|js)$/i.test(filePath))
            return true;
        if (process.platform !== 'win32') {
            fs.accessSync(filePath, fs.constants.X_OK);
        }
        return true;
    }
    catch {
        return false;
    }
}
function resolveStemWithExts(stem, platform = process.platform) {
    const exts = platform === 'win32' ? ['.exe', '.cmd', '.bat', '.cjs', '.mjs', '.js', ''] : [''];
    for (const ext of exts) {
        const candidate = `${stem}${ext}`;
        if (isExecutableCandidate(candidate))
            return candidate;
    }
    return null;
}
function searchPathForCodex(platform = process.platform) {
    const pathEnv = process.env.PATH ?? '';
    for (const rawDir of pathEnv.split(path.delimiter).filter(Boolean)) {
        const dir = rawDir.replace(/^"|"$/g, '');
        const found = resolveStemWithExts(path.join(dir, 'codex'), platform);
        if (found)
            return found;
    }
    return null;
}
function fallbackCodexCandidates(platform = process.platform) {
    const home = platform === 'win32' ? process.env.USERPROFILE || os.homedir() : os.homedir();
    if (platform === 'win32') {
        const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
        const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
        return [
            path.join(localAppData, 'mise', 'installs', 'npm-openai-codex', 'latest', 'codex'),
            path.join(localAppData, 'mise', 'shims', 'codex'),
            path.join(appData, 'npm', 'codex'),
            path.join(home, '.local', 'bin', 'codex'),
            path.join(localAppData, 'Programs', 'Codex', 'bin', 'codex'),
        ];
    }
    return [
        path.join(home, '.local', 'share', 'mise', 'shims', 'codex'),
        path.join(home, '.local', 'bin', 'codex'),
        '/opt/homebrew/bin/codex',
        '/usr/local/bin/codex',
        '/Applications/Codex.app/Contents/Resources/codex',
    ];
}
export function resolveCodexBinary() {
    const explicit = process.env.PASSBOX_CODEX_BIN || process.env.CODEX_BIN;
    if (explicit) {
        if (isExecutableCandidate(explicit))
            return explicit;
        const withExt = resolveStemWithExts(explicit);
        if (withExt)
            return withExt;
        throw new Error(`Configured Codex binary does not exist or is not executable: ${explicit}`);
    }
    const onPath = searchPathForCodex();
    if (onPath)
        return onPath;
    for (const stem of fallbackCodexCandidates()) {
        const found = resolveStemWithExts(stem);
        if (found)
            return found;
    }
    throw new Error('OpenAI Codex CLI (`codex`) was not found on PATH or standard install locations. ' +
        'Verify your installation with `codex --version`.');
}
export function unwrapNodeCmdShim(cmdFilePath) {
    try {
        const content = fs.readFileSync(cmdFilePath, 'utf8').slice(0, 4096);
        if (!/node|%_prog%/i.test(content))
            return null;
        const match = /%(?:~)?dp0%[\\/]*([^"%*\r\n]+?\.(?:mjs|cjs|js))"?\s+%\*/i.exec(content);
        if (!match)
            return null;
        const relScript = match[1].replaceAll('\\', '/').replace(/^\/+/, '');
        const resolvedScript = path.resolve(path.dirname(cmdFilePath), relScript);
        return fs.existsSync(resolvedScript) ? resolvedScript : null;
    }
    catch {
        return null;
    }
}
function quoteCmdArg(value) {
    if (value.length === 0)
        return '""';
    if (!/[\s"&|<>()^%!;,=]/.test(value))
        return value;
    const escaped = value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1');
    return `"${escaped.replaceAll('%', '"^%"')}"`;
}
export function buildCodexSpawnCommand(binaryPath, args, platform = process.platform) {
    if (/\.(mjs|cjs|js)$/i.test(binaryPath)) {
        return {
            cmd: process.execPath,
            args: [binaryPath, ...args],
            windowsVerbatimArguments: false,
        };
    }
    if (/\.(cmd|bat)$/i.test(binaryPath)) {
        const unwrapped = unwrapNodeCmdShim(binaryPath);
        if (unwrapped) {
            return {
                cmd: process.execPath,
                args: [unwrapped, ...args],
                windowsVerbatimArguments: false,
            };
        }
        if (platform === 'win32') {
            const cmdLine = [binaryPath, ...args].map(quoteCmdArg).join(' ');
            return {
                cmd: process.env.ComSpec || 'cmd.exe',
                args: ['/d', '/s', '/c', `"${cmdLine}"`],
                windowsVerbatimArguments: true,
            };
        }
    }
    return { cmd: binaryPath, args, windowsVerbatimArguments: false };
}
