import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PASSBOX_BOARD_RESOURCE_URI = 'ui://passbox/board.html';
export const PASSBOX_BOARD_MIME_TYPE = 'text/html;profile=mcp-app';

const SELF_DIR = path.dirname(fileURLToPath(import.meta.url));

function resolveBoardAssetPath(): string {
  const candidates = [
    process.env.PASSBOX_APP_HTML || '',
    path.resolve(SELF_DIR, '..', '..', 'assets', 'board.html'),
    path.resolve(SELF_DIR, '..', '..', '..', 'assets', 'board.html'),
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error(`Passbox board.html asset not found relative to ${SELF_DIR}`);
}

export function getPassboxBoardHtml(): string {
  return fs.readFileSync(resolveBoardAssetPath(), 'utf8');
}
