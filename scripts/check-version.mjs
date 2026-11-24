// Версии в manifest.json и package.json совпадают (и с тегом релиза, если он передан: v0.3.0).
import { readFileSync } from 'node:fs';

const manifest = JSON.parse(readFileSync(new URL('../extension/manifest.json', import.meta.url))).version;
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).version;
const tag = (process.argv[2] || '').replace(/^refs\/tags\//, '').replace(/^v/, '');

const errors = [];
if (manifest !== pkg) errors.push(`manifest.json ${manifest} ≠ package.json ${pkg}`);
if (tag && tag !== manifest) errors.push(`тег v${tag} ≠ manifest.json ${manifest}`);
if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}
console.log(`Версия ${manifest}${tag ? ', совпадает с тегом' : ''}`);
