import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUNDLE = path.join(ROOT, 'dist', 'plugin-bundle');

fs.rmSync(BUNDLE, { recursive: true, force: true });
fs.mkdirSync(BUNDLE, { recursive: true });

// Promote .antigravity-plugin/plugin.json to root plugin.json in standalone bundle
fs.copyFileSync(
  path.join(ROOT, '.antigravity-plugin', 'plugin.json'),
  path.join(BUNDLE, 'plugin.json')
);
fs.copyFileSync(path.join(ROOT, 'mcp_config.json'), path.join(BUNDLE, 'mcp_config.json'));

for (const optionalFile of ['README.md', 'LICENSE']) {
  const src = path.join(ROOT, optionalFile);
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, path.join(BUNDLE, optionalFile));
  }
}

for (const dirName of ['assets', 'skills']) {
  const srcDir = path.join(ROOT, dirName);
  if (fs.existsSync(srcDir)) {
    fs.cpSync(srcDir, path.join(BUNDLE, dirName), { recursive: true });
  }
}

// Copy compiled JS runtime into bundle/dist (excluding plugin-bundle itself)
const distSrc = path.join(ROOT, 'dist');
const bundleDist = path.join(BUNDLE, 'dist');
fs.mkdirSync(bundleDist, { recursive: true });
for (const entry of fs.readdirSync(distSrc, { withFileTypes: true })) {
  if (entry.name === 'plugin-bundle') continue;
  fs.cpSync(path.join(distSrc, entry.name), path.join(bundleDist, entry.name), {
    recursive: true,
  });
}

// Ensure standalone bundle loads ESM modules reliably on Node 20.0-20.18 as well as Node 20.19+/22+/24+
fs.writeFileSync(
  path.join(bundleDist, 'package.json'),
  `${JSON.stringify({ type: 'module' }, null, 2)}\n`,
  'utf8'
);
