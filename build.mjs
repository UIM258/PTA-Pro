import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const header = fs.readFileSync(path.join(root, 'src', 'header.txt'), 'utf8').trim();
const core = fs.readFileSync(path.join(root, 'src', 'core.cjs'), 'utf8').trim();
const app = fs.readFileSync(path.join(root, 'src', 'app.js'), 'utf8').trim();
const styles = fs.readFileSync(path.join(root, 'src', 'styles.css'), 'utf8');

if (!app.includes('__PTAF_STYLES__')) {
  throw new Error('app.js 中找不到 __PTAF_STYLES__ 占位符');
}

const output = [
  header,
  '',
  '/* Core data model and pure helpers. */',
  core,
  '',
  '/* PTA page integration and UI. */',
  app.replace('__PTAF_STYLES__', '`\n' + styles + '\n`'),
  '',
].join('\n');

const outputDir = path.join(root, 'outputs');
fs.mkdirSync(outputDir, { recursive: true });
fs.writeFileSync(path.join(outputDir, 'pta-favorites.user.js'), output, 'utf8');
console.log(`built ${path.join(outputDir, 'pta-favorites.user.js')} (${Buffer.byteLength(output)} bytes)`);

