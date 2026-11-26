import path from 'node:path';
import type { ChangedFileEntry, DiffTotals, GuardSignals, OmitReason } from '../types.js';
import { runGitSync } from './git-snapshot.js';

const LOCKFILE_BASENAMES = new Set([
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
  'cargo.lock',
  'poetry.lock',
  'pipfile.lock',
  'uv.lock',
  'composer.lock',
  'gemfile.lock',
  'go.sum',
]);

const GENERATED_PATTERNS = [
  /\.min\.(?:js|mjs|cjs|css)$/i,
  /\.bundle\.(?:js|css)$/i,
  /\.map$/i,
  /\.snap$/i,
  /(?:^|\/)__snapshots__\//i,
];

const SINGLE_FILE_PREVIEW_OMIT_BYTES = 64 * 1024;

export function normalizeRepoRelPath(p: string): string {
  return p.replaceAll('\\', '/').replace(/^\.\/+/, '');
}

function classifyOmitReason(
  relPath: string,
  binary: boolean,
  patchByteLength: number
): OmitReason | undefined {
  if (binary) return 'binary';
  const base = path.posix.basename(normalizeRepoRelPath(relPath)).toLowerCase();
  if (LOCKFILE_BASENAMES.has(base)) return 'lockfile';
  if (GENERATED_PATTERNS.some((re) => re.test(relPath))) return 'generated';
  if (patchByteLength > SINGLE_FILE_PREVIEW_OMIT_BYTES) return 'oversized_file';
  return undefined;
}

function stripTrailingDiffTab(raw: string): string {
  const noCr = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
  return noCr.endsWith('\t') ? noCr.slice(0, -1) : noCr;
}

export function splitUnifiedDiffByFile(fullPatch: string): Map<string, string> {
  const byFile = new Map<string, string>();
  if (!fullPatch.trim()) return byFile;

  const lines = fullPatch.split('\n');
  let currentPath: string | null = null;
  let pendingDeletedPath: string | null = null;
  let inHeader = false;
  let chunkLines: string[] = [];

  const flush = () => {
    if (currentPath && chunkLines.length > 0) {
      byFile.set(currentPath, `${chunkLines.join('\n').trimEnd()}\n`);
    }
    currentPath = null;
    pendingDeletedPath = null;
    inHeader = false;
    chunkLines = [];
  };

  for (const rawLine of lines) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line.startsWith('diff --git ')) {
      flush();
      inHeader = true;
      const match = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      if (match) {
        currentPath = normalizeRepoRelPath(match[2]);
      }
      chunkLines.push(line);
    } else if (chunkLines.length > 0) {
      if (inHeader) {
        if (line.startsWith('@@ ') || line.startsWith('Binary files ')) {
          inHeader = false;
        } else if (line.startsWith('rename to ')) {
          currentPath = normalizeRepoRelPath(stripTrailingDiffTab(line.slice(10)));
        } else if (line.startsWith('copy to ')) {
          currentPath = normalizeRepoRelPath(stripTrailingDiffTab(line.slice(8)));
        } else if (line.startsWith('--- a/')) {
          pendingDeletedPath = normalizeRepoRelPath(stripTrailingDiffTab(line.slice(6)));
        } else if (line === '+++ /dev/null' && pendingDeletedPath) {
          currentPath = pendingDeletedPath;
        } else if (line.startsWith('+++ b/')) {
          currentPath = normalizeRepoRelPath(stripTrailingDiffTab(line.slice(6)));
        }
      }
      chunkLines.push(line);
    }
  }
  flush();
  return byFile;
}

export function analyzeGuardSignals(perFilePatches: Map<string, string>): GuardSignals {
  let tryCatch = 0;
  let nullishOrType = 0;
  let fallbacks = 0;
  let earlyReturns = 0;

  for (const [filePath, patch] of perFilePatches.entries()) {
    const norm = normalizeRepoRelPath(filePath).toLowerCase();
    // Skip lockfiles, markdown docs, and snapshots
    if (LOCKFILE_BASENAMES.has(path.posix.basename(norm)) || /\.(md|txt|json|ya?ml|lock)$/i.test(norm)) {
      continue;
    }
    for (const rawLine of patch.split('\n')) {
      if (!rawLine.startsWith('+') || rawLine.startsWith('+++')) continue;
      const code = rawLine.slice(1);
      if (/\b(?:try\s*\{|except\b)/.test(code)) tryCatch++;
      if (/\b(?:typeof\s+\w+|instanceof\s+\w+)\b|[!=]==?\s*(?:null|undefined)\b|\bis\s+None\b/.test(code)) {
        nullishOrType++;
      }
      if (/\?\?\s*\S+|\|\|\s*(?:['"`[\{0]|false\b)/.test(code)) fallbacks++;
      if (/^\s*if\s*\([^)]+\)\s*return\b/.test(code)) earlyReturns++;
    }
  }

  return {
    try_catch_added: tryCatch,
    nullish_or_type_guards_added: nullishOrType,
    fallback_defaults_added: fallbacks,
    early_guard_returns_added: earlyReturns,
    note: 'Descriptive heuristic counts over added code lines; not automatic proof of defect or over-defensive code.',
  };
}

export function computeUnexpectedFiles(
  changedPaths: string[],
  expectedFiles?: string[]
): string[] {
  if (!expectedFiles || expectedFiles.length === 0) return [];
  const normalizedExpected = expectedFiles.map((f) => normalizeRepoRelPath(f).replace(/\/+$/, ''));
  return changedPaths.filter((changed) => {
    const norm = normalizeRepoRelPath(changed);
    return !normalizedExpected.some(
      (exp) => norm === exp || norm.startsWith(`${exp}/`)
    );
  });
}

export interface ComputedTreeDiff {
  files: ChangedFileEntry[];
  totals: DiffTotals;
  fullPatch: string;
  previewEligiblePatch: string;
  perFilePatches: Map<string, string>;
  guardSignals: GuardSignals;
}

function parseNameStatusZ(raw: string): Map<string, { status: ChangedFileEntry['status']; oldPath?: string }> {
  const map = new Map<string, { status: ChangedFileEntry['status']; oldPath?: string }>();
  if (!raw) return map;
  const tokens = raw.split('\0').filter((t) => t.length > 0);
  for (let i = 0; i < tokens.length; i++) {
    const statusToken = tokens[i];
    const code = (statusToken[0] ?? 'M') as ChangedFileEntry['status'];
    if (code === 'R' || code === 'C') {
      const oldPath = normalizeRepoRelPath(tokens[++i] ?? '');
      const newPath = normalizeRepoRelPath(tokens[++i] ?? '');
      if (newPath) map.set(newPath, { status: code, oldPath });
    } else {
      const filePath = normalizeRepoRelPath(tokens[++i] ?? '');
      if (filePath) map.set(filePath, { status: code });
    }
  }
  return map;
}

function parseNumstatZ(raw: string): Map<string, { insertions: number; deletions: number; binary: boolean; oldPath?: string }> {
  const map = new Map<string, { insertions: number; deletions: number; binary: boolean; oldPath?: string }>();
  if (!raw) return map;
  const tokens = raw.split('\0').filter((t) => t.length > 0);
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const parts = token.split('\t');
    if (parts.length < 3) continue;
    const [insStr, delStr, inlinePath] = parts;
    const binary = insStr === '-' || delStr === '-';
    const insertions = binary ? 0 : Number(insStr) || 0;
    const deletions = binary ? 0 : Number(delStr) || 0;
    if (inlinePath === '') {
      // Rename/copy with -z puts empty path after tabs, followed by oldPath\0newPath\0
      const oldPath = normalizeRepoRelPath(tokens[++i] ?? '');
      const newPath = normalizeRepoRelPath(tokens[++i] ?? '');
      if (newPath) map.set(newPath, { insertions, deletions, binary, oldPath });
    } else {
      const filePath = normalizeRepoRelPath(inlinePath);
      map.set(filePath, { insertions, deletions, binary });
    }
  }
  return map;
}

export function computeTreeDiff(
  repoRoot: string,
  fromTreeOid: string,
  toTreeOid: string
): ComputedTreeDiff {
  if (fromTreeOid === toTreeOid) {
    return {
      files: [],
      totals: { files_changed: 0, insertions: 0, deletions: 0, net_lines: 0 },
      fullPatch: '',
      previewEligiblePatch: '',
      perFilePatches: new Map(),
      guardSignals: analyzeGuardSignals(new Map()),
    };
  }

  const nameStatusRes = runGitSync(repoRoot, [
    'diff-tree',
    '-r',
    '-M',
    '--name-status',
    '-z',
    fromTreeOid,
    toTreeOid,
  ]);
  if (nameStatusRes.status !== 0) {
    throw new Error(
      `git diff-tree --name-status failed (exit ${nameStatusRes.status}): ${nameStatusRes.stderr.trim() || 'unknown error'}`
    );
  }
  const numstatRes = runGitSync(repoRoot, [
    'diff-tree',
    '-r',
    '-M',
    '--numstat',
    '-z',
    fromTreeOid,
    toTreeOid,
  ]);
  if (numstatRes.status !== 0) {
    throw new Error(
      `git diff-tree --numstat failed (exit ${numstatRes.status}): ${numstatRes.stderr.trim() || 'unknown error'}`
    );
  }
  const patchRes = runGitSync(repoRoot, [
    'diff',
    '-M',
    '--unified=3',
    fromTreeOid,
    toTreeOid,
  ]);
  if (patchRes.status !== 0) {
    throw new Error(
      `git diff failed (exit ${patchRes.status}): ${patchRes.stderr.trim() || 'unknown error'}`
    );
  }

  const statusMap = parseNameStatusZ(nameStatusRes.stdout);
  const numMap = parseNumstatZ(numstatRes.stdout);
  const fullPatch = patchRes.stdout;
  const perFilePatches = splitUnifiedDiffByFile(fullPatch);

  const allPaths = Array.from(new Set([...statusMap.keys(), ...numMap.keys()])).sort();
  const files: ChangedFileEntry[] = [];
  let totalIns = 0;
  let totalDel = 0;
  const previewPatchChunks: string[] = [];

  for (const relPath of allPaths) {
    const st = statusMap.get(relPath);
    const nm = numMap.get(relPath);
    const insertions = nm?.insertions ?? 0;
    const deletions = nm?.deletions ?? 0;
    const binary = nm?.binary ?? false;
    totalIns += insertions;
    totalDel += deletions;

    const filePatch = perFilePatches.get(relPath) ?? '';
    const omitReason = classifyOmitReason(
      relPath,
      binary,
      Buffer.byteLength(filePatch, 'utf8')
    );
    const omitted = Boolean(omitReason);
    if (!omitted && filePatch) {
      previewPatchChunks.push(filePatch.trimEnd());
    }

    const oldPath = st?.oldPath ?? nm?.oldPath;
    files.push({
      path: relPath,
      ...(oldPath ? { old_path: oldPath } : {}),
      status: st?.status ?? 'M',
      insertions,
      deletions,
      binary,
      omitted_from_preview: omitted,
      ...(omitReason ? { omit_reason: omitReason } : {}),
    });
  }

  return {
    files,
    totals: {
      files_changed: files.length,
      insertions: totalIns,
      deletions: totalDel,
      net_lines: totalIns - totalDel,
    },
    fullPatch,
    previewEligiblePatch: previewPatchChunks.length ? `${previewPatchChunks.join('\n')}\n` : '',
    perFilePatches,
    guardSignals: analyzeGuardSignals(perFilePatches),
  };
}
