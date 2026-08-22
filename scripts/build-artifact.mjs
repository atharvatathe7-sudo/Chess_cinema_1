#!/usr/bin/env node
/**
 * Packages the production build into ONE self-contained HTML file.
 *
 * Why this exists: the app is normally served as a directory (index.html +
 * a JS bundle + a 7 MB engine .wasm in /engine/). The Claude Artifact used
 * for phone testing serves exactly one HTML file and cannot host separate
 * assets, so the engine is inlined here as base64 and handed to the app via
 * window.__CHESS_CINEMA_ENGINE__, which src/analysis/engineAssets.ts reads.
 *
 * This changes only WHERE the engine bytes come from. The worker construction,
 * the UCI protocol, the analysis code and the renderer are byte-for-byte the
 * same as the normal build — there is no second engine integration and no
 * mock anywhere.
 *
 * Usage: node scripts/build-artifact.mjs [outputPath]
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const DIST = 'dist';
const ARTIFACT_SIZE_CAP = 16 * 1024 * 1024;

const outputPath = process.argv[2] ?? 'dist/chess-cinema-artifact.html';

function findBundle() {
  const assets = readdirSync(join(DIST, 'assets'));
  const bundle = assets.find((f) => f.endsWith('.js'));
  if (!bundle) throw new Error('No JS bundle found in dist/assets — run `vite build` first.');
  return join(DIST, 'assets', bundle);
}

const bundleJs = readFileSync(findBundle(), 'utf8');
const engineGlue = readFileSync(join(DIST, 'engine', 'stockfish-18-lite-single.js'), 'utf8');
const engineWasm = readFileSync(join(DIST, 'engine', 'stockfish-18-lite-single.wasm'));
const wasmBase64 = engineWasm.toString('base64');

// The glue and the app bundle are injected into <script> bodies, so any
// literal "</script>" inside them would end the tag early. JSON.stringify
// gives a safe JS string literal; the split guards the closing-tag sequence.
const glueLiteral = JSON.stringify(engineGlue).replace(/<\/script/gi, '<\\/script');

const banner = `<div style="font-family:system-ui,sans-serif;font-size:12px;line-height:1.5;background:#eef4ff;color:#1e3a6b;border-bottom:1px solid #b9cdf0;padding:8px 14px;">
  <strong>Phase 2.1 build snapshot</strong> — real Stockfish 18 Lite (single-threaded WASM) runs in a Web Worker inside this page.
  Tap <strong>Analyze Game</strong> after loading a PGN; the engine is ~7&nbsp;MB and takes a moment to start on first use.
  Exported files cannot download from inside this preview.
</div>`;

const html = `<title>Chess Cinema Phase 2.1</title>
${banner}
<div id="app"></div>
<script>
window.__CHESS_CINEMA_ENGINE__ = {
  glue: ${glueLiteral},
  wasmBase64: "${wasmBase64}"
};
</script>
<script type="module">
${bundleJs}
</script>
`;

writeFileSync(outputPath, html);

const bytes = Buffer.byteLength(html);
const mb = (bytes / 1024 / 1024).toFixed(2);
console.log(`wrote ${outputPath}`);
console.log(`  app bundle : ${(Buffer.byteLength(bundleJs) / 1024).toFixed(1)} KB`);
console.log(`  engine glue: ${(Buffer.byteLength(engineGlue) / 1024).toFixed(1)} KB`);
console.log(`  engine wasm: ${(engineWasm.length / 1024 / 1024).toFixed(2)} MB raw -> ${(wasmBase64.length / 1024 / 1024).toFixed(2)} MB base64`);
console.log(`  TOTAL      : ${mb} MB  (Artifact cap: 16.00 MB)`);

if (bytes > ARTIFACT_SIZE_CAP) {
  console.error(`ERROR: ${mb} MB exceeds the 16 MB Artifact limit.`);
  process.exit(1);
}
