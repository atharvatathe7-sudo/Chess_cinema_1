import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

const PGN = '1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7';

test.beforeEach(async ({ page }) => {
  await page.goto('/tests/fixtures/harness.html');
  await page.evaluate(() => (window as any).__harness.ready());
});

/**
 * Correction 6's central invariant, in two parts:
 *
 * 1. Structural: preview/PreviewLoop.ts and export/runExport.ts each
 *    import render/Renderer's `render` and call it — neither contains
 *    a second implementation of board/piece/annotation drawing. A
 *    static source check, because a runtime spy can't observe "is this
 *    literally the same function" any more convincingly than reading
 *    the one import statement each file has.
 * 2. Behavioral: given identical AppState, assets, logicalTimeMs, and
 *    render dimensions, the preview code path (previewTick) and the
 *    export code path (renderExportFrame) produce pixel-identical
 *    output.
 */
test('preview and export both call render/Renderer.render — no second drawing implementation exists', () => {
  const previewSource = readFileSync('src/preview/PreviewLoop.ts', 'utf8');
  const exportSource = readFileSync('src/export/runExport.ts', 'utf8');

  expect(previewSource).toMatch(/import\s*\{[^}]*\brender\b[^}]*\}\s*from\s*['"].*render\/Renderer['"]/);
  expect(previewSource).toMatch(/\brender\(/);

  expect(exportSource).toMatch(/import\s*\{[^}]*\brender\b[^}]*\}\s*from\s*['"].*render\/Renderer['"]/);
  expect(exportSource).toMatch(/\brender\(/);

  // Neither file should independently issue canvas drawing calls — that
  // would be exactly the "second implementation" the architecture rules out.
  for (const source of [previewSource, exportSource]) {
    expect(source).not.toMatch(/\.fillRect\(|\.drawImage\(|\.stroke\(|\.fill\(/);
  }
});

test('preview and export produce pixel-identical output for the same state, time, and dims', async ({ page }) => {
  const times = [0, 300, 600, 900, 1800, 3000];

  for (const t of times) {
    const [previewHash, exportHash] = await page.evaluate(
      ({ pgn, t }) => {
        const h = (window as any).__harness;
        h.renderViaPreview('canvas-a', pgn, t);
        const previewHash = h.hashCanvas('canvas-a');
        h.renderViaExport('canvas-b', pgn, t);
        const exportHash = h.hashCanvas('canvas-b');
        return [previewHash, exportHash];
      },
      { pgn: PGN, t }
    );

    expect(exportHash, `mismatch at logicalTimeMs=${t}`).toBe(previewHash);
  }
});
