// Bundles the game into dist/inkland.html: one self-contained file that runs by
// double-clicking it (no server, no network). ES module syntax is stripped and
// the modules are concatenated in dependency order inside a single closure.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODULES = [
  'src/engine/util.js',
  'src/engine/constants.js',
  'src/engine/arena.js',
  'src/engine/bot.js',
  'src/engine/game.js',
  'src/client/palette.js',
  'src/client/storage.js',
  'src/client/missions.js',
  'src/client/replay.js',
  'src/client/haptics.js',
  'src/client/audio.js',
  'src/client/input.js',
  'src/client/renderer.js',
  'src/client/net.js',
  'src/client/ui.js',
  'src/client/main.js',
];

const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

const js = MODULES.map((file) => {
  const src = read(file)
    .replace(/^import\s[^;]*;\s*$/gm, '')
    .replace(/^export\s+(?=(const|let|function|class|async)\b)/gm, '')
    .replace(/^export\s*\{[^}]*\};?\s*$/gm, '');
  if (/^\s*(import|export)\b/m.test(src)) throw new Error(`Unsupported module syntax left in ${file}`);
  return `// ---- ${file} ----\n${src}`;
}).join('\n');

// Fail the build on syntax errors (e.g. two modules declaring the same name).
new Function(js); // eslint-disable-line no-new-func

const icon = `data:image/svg+xml;base64,${Buffer.from(read('icon.svg')).toString('base64')}`;
let html = read('index.html')
  .replace(/^\s*<link rel="manifest"[^>]*>\n/m, '')
  .replace('href="icon.svg"', `href="${icon}"`)
  .replace('<link rel="stylesheet" href="styles.css">', () => `<style>\n${read('styles.css')}</style>`)
  .replace('<script type="module" src="src/client/main.js"></script>', () => `<script>\n(() => {\n'use strict';\n${js}\n})();\n</script>`);

fs.mkdirSync(path.join(ROOT, 'dist'), { recursive: true });
const out = path.join(ROOT, 'dist', 'inkland.html');
fs.writeFileSync(out, html);
console.log(`Built ${path.relative(ROOT, out)} (${(html.length / 1024).toFixed(1)} KB)`);
