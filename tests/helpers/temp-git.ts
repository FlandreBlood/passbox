import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

export function execGit(cwd: string, args: string[]): string {
  const res = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
  });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${res.stderr}`);
  }
  return res.stdout;
}

export function createTempGitRepo(options?: { unbornHead?: boolean }): {
  repoDir: string;
  cleanup: () => void;
} {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'passbox-repo-'));
  execGit(repoDir, ['init']);
  execGit(repoDir, ['config', 'user.name', 'Passbox Test']);
  execGit(repoDir, ['config', 'user.email', 'test@passbox.local']);

  fs.writeFileSync(path.join(repoDir, '.gitignore'), '.env.secret\nignored-dir/\n', 'utf8');
  fs.writeFileSync(
    path.join(repoDir, 'src-app.ts'),
    'export function greet(name: string): string {\n  return `Hello, ${name}`;\n}\n',
    'utf8'
  );

  if (!options?.unbornHead) {
    execGit(repoDir, ['add', '.']);
    execGit(repoDir, ['commit', '-m', 'Initial commit']);
  }

  return {
    repoDir,
    cleanup: () => {
      try {
        execGit(repoDir, ['worktree', 'prune']);
      } catch {}
      try {
        fs.rmSync(repoDir, { recursive: true, force: true });
      } catch {}
    },
  };
}

export function hashFileSha256(filePath: string): string | null {
  if (!fs.existsSync(filePath)) return null;
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}
