// Собирает dist/kto-eto-<версия>.zip из папки extension/ — для GitHub Releases и Chrome Web Store.
import { readFileSync, mkdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const root = new URL('..', import.meta.url).pathname;
const { version } = JSON.parse(readFileSync(`${root}extension/manifest.json`, 'utf8'));
const out = `${root}dist/kto-eto-${version}.zip`;
mkdirSync(`${root}dist`, { recursive: true });
rmSync(out, { force: true });
// manifest.json — в корне архива; системный мусор не берём
execFileSync('zip', ['-r', '-q', '-X', out, '.', '-x', '*.DS_Store', '-x', '__MACOSX/*'], { cwd: `${root}extension`, stdio: 'inherit' });
console.log(out);
