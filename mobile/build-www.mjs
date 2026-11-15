import { cpSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const source = join(here, '..', 'public');
const target = join(here, 'www');
const skip = new Set(['api.php', 'oauth.php', '.user.ini', 'sw.js']);

if (!existsSync(source)) {
  console.error('Pasta public não encontrada');
  process.exit(1);
}
rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
cpSync(source, target, { recursive: true, filter: (src) => !skip.has(basename(src)) });
console.log('www pronto');
