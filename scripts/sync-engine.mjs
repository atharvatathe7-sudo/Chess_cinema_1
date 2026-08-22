#!/usr/bin/env node
/**
 * Copies the Stockfish engine files from the pinned npm package into
 * public/engine/, where Vite serves them verbatim.
 *
 * They are copied rather than committed so the repository does not carry a
 * 7 MB binary that is already pinned in package-lock.json — and so the served
 * engine can never silently drift from the version the lockfile installs.
 *
 * Runs automatically before `npm run dev` and `npm run build`.
 *
 * Which build and why:
 *   stockfish-18-lite-single = the LITE net (~7 MB rather than ~113 MB) and
 *   SINGLE-threaded. Single-threaded matters beyond size: the multi-threaded
 *   builds need SharedArrayBuffer, which requires COOP/COEP response headers
 *   that a static deployment (and the Artifact sandbox) cannot set.
 */
import { copyFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(projectRoot, 'node_modules', 'stockfish');
const target = join(projectRoot, 'public', 'engine');

const FILES = [
  ['bin/stockfish-18-lite-single.js', 'stockfish-18-lite-single.js'],
  ['bin/stockfish-18-lite-single.wasm', 'stockfish-18-lite-single.wasm'],
  // Stockfish is GPL-3.0; its licence travels with the binaries we serve.
  ['Copying.txt', 'STOCKFISH-LICENSE-GPLv3.txt']
];

if (!existsSync(source)) {
  console.error('stockfish package not found in node_modules — run `npm install` first.');
  process.exit(1);
}

mkdirSync(target, { recursive: true });
for (const [from, to] of FILES) {
  copyFileSync(join(source, from), join(target, to));
}
console.log(`synced ${FILES.length} Stockfish engine files into public/engine/`);
