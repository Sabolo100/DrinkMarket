#!/usr/bin/env node
/**
 * A futo peldany azonositoja: verzio + a forras tartalmi hash-e.
 *
 * A verzio egyetlen forrasa a gyoker package.json. A build-azonosito a
 * megadott konyvtarak TARTALMABOL szamolodik (node_modules, dist, .next
 * nelkul), tehat ugyanabbol a forrasbol mindig ugyanaz jon ki - akkor is, ha
 * a Coolify nem adja at a git commitot a buildnek (a .git a .dockerignore-ban
 * van).
 *
 *   node scripts/build-info.mjs <kimenet.json> <konyvtar|fajl> [...]
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const [out, ...roots] = process.argv.slice(2);
if (!out || roots.length === 0) {
  console.error('Hasznalat: node scripts/build-info.mjs <kimenet.json> <konyvtar|fajl> [...]');
  process.exit(2);
}

const SKIP = new Set(['node_modules', 'dist', '.next', 'coverage', 'build-info.json']);

function collect(p, acc) {
  if (statSync(p).isDirectory()) {
    for (const name of readdirSync(p).sort()) {
      if (SKIP.has(name) || name.endsWith('.tsbuildinfo')) continue;
      collect(path.join(p, name), acc);
    }
  } else {
    acc.push(p);
  }
}

const files = [];
for (const root of roots) collect(root, files);

const hash = createHash('sha256');
for (const file of files.sort()) {
  hash.update(file.split(path.sep).join('/'));
  hash.update('\0');
  // A sorvegek ne szamitsanak: egy Windowson es egy Linuxon kiolvasott
  // ugyanazon forras ugyanazt az azonositot adja.
  hash.update(readFileSync(file).toString('binary').replace(/\r\n/g, '\n'));
  hash.update('\0');
}

const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
const info = { version, build: hash.digest('hex').slice(0, 8), builtAt: new Date().toISOString() };
writeFileSync(out, `${JSON.stringify(info)}\n`);
console.log(`build-info: v${info.version} (${info.build}) -> ${out}`);
