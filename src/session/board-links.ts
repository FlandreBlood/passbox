import fs from 'node:fs';
import { redactSensitiveText } from '../observability/redact.js';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export interface BoardFileLink {
  uri: string;
  uri_with_line?: string;
  rel_path: string;
  line?: number;
  end_line?: number;
  column?: number;
}

const INVALID_PATH_TEXT = /[\0\r\n\u2028\u2029]/;
const LINE_FRAGMENT = /#L(?<line>[1-9]\d*)(?:-L(?<endLine>[1-9]\d*))?$/;
const LINE_SUFFIXES = [
  LINE_FRAGMENT,
  /:(?<line>[1-9]\d*):(?<column>[1-9]\d*)$/,
  /:(?<line>[1-9]\d*)-(?<endLine>[1-9]\d*)$/,
  /:(?<line>[1-9]\d*)$/,
];

export function resolveWorkspaceFileLink(workspace: string, filename: string): BoardFileLink | null {
  if (!filename || INVALID_PATH_TEXT.test(filename)) return null;
  const segments = process.platform === 'win32' ? filename.split(/[\\/]/) : filename.split('/');
  if (segments.includes('..')) return null;

  try {
    const workspaceReal = fs.realpathSync.native(workspace);
    const targetReal = fs.realpathSync.native(path.resolve(workspaceReal, filename));
    // path.win32.relative compares path components case-insensitively.
    const relative = path.relative(workspaceReal, targetReal);
    if (
      !relative || relative === '..' || relative.startsWith('..' + path.sep) ||
      path.isAbsolute(relative) || redactSensitiveText(targetReal) !== targetReal || !fs.statSync(targetReal).isFile()
    ) return null;

    return {
      uri: pathToFileURL(targetReal).href,
      rel_path: relative.split(path.sep).join('/'),
    };
  } catch {
    return null;
  }
}

function withLocation(link: BoardFileLink | null, match: RegExpExecArray): BoardFileLink | null {
  if (!link) return null;
  const position = match.groups!;
  const line = Number(position.line);
  const endLine = position.endLine === undefined ? undefined : Number(position.endLine);
  const column = position.column === undefined ? undefined : Number(position.column);
  if (
    !Number.isSafeInteger(line) ||
    (endLine !== undefined && (!Number.isSafeInteger(endLine) || endLine < line)) ||
    (column !== undefined && !Number.isSafeInteger(column))
  ) return null;

  return {
    ...link,
    uri_with_line: link.uri + '#L' + line + (endLine === undefined ? '' : '-L' + endLine),
    line,
    ...(endLine === undefined ? {} : { end_line: endLine }),
    ...(column === undefined ? {} : { column }),
  };
}

export function resolveEvidenceFileLink(
  workspace: string,
  evidence: string | null | undefined
): BoardFileLink | null {
  if (!evidence || INVALID_PATH_TEXT.test(evidence)) return null;
  let filename = evidence.trim();
  if (filename.startsWith('\x60') && filename.endsWith('\x60')) {
    filename = filename.slice(1, -1);
  }
  if (!filename.trim()) return null;

  if (/^file:\/\//i.test(filename)) {
    try {
      const url = new URL(filename);
      const location = LINE_FRAGMENT.exec(url.hash);
      if (url.search || (url.hash && location?.index !== 0)) return null;
      const link = resolveWorkspaceFileLink(workspace, fileURLToPath(url));
      return location ? withLocation(link, location) : link;
    } catch {
      return null;
    }
  }

  if (/^(?:https?|mailto|ui|file):/i.test(filename)) return null;
  const windowsAbsolute = process.platform === 'win32' && /^[a-z]:[\\/]/i.test(filename);
  if (!windowsAbsolute && /^[a-z][a-z\d+.-]*:/i.test(filename)) {
    // A bare filename with a line suffix can have the same prefix syntax as a URI.
    if (!/^[^:]+:[1-9]\d*(?:(?:[:-])[1-9]\d*)?$/.test(filename)) return null;
  }

  const whole = resolveWorkspaceFileLink(workspace, filename);
  if (whole) return whole;
  for (const suffix of LINE_SUFFIXES) {
    const location = suffix.exec(filename);
    if (!location) continue;
    const link = withLocation(resolveWorkspaceFileLink(workspace, filename.slice(0, location.index)), location);
    if (link) return link;
  }
  return null;
}
