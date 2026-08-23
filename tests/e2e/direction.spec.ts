import { expect, test } from '@playwright/test';

/**
 * Phase 2.5 — live UI integration: the REAL Stockfish engine, driving the
 * actual application through Load PGN -> Analyze Game -> Generate Cinematic,
 * confirming the Director-produced Timeline actually reaches the running
 * app (not just a standalone pipeline probe — see tests/e2e/director.spec.ts
 * for that) and that every existing playback/export control keeps working
 * against it, with zero renderer/export/state changes beyond what
 * state/directionActions.ts and ui/panel.ts add.
 */

test.describe.configure({ timeout: 180_000 });

const EVERGREEN =
  '1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. b4 Bxb4 5. c3 Ba5 6. d4 exd4 7. O-O d3 8. Qb3 Qf6 9. e5 Qg6 10. Re1 Nge7 11. Ba3 b5 12. Qxb5 Rb8 13. Qa4 Bb6 14. Nbd2 Bb7 15. Ne4 Qf5 16. Bxd3 Qh5 17. Nf6+ gxf6 18. exf6 Rg8 19. Rad1 Qxf3 20. Rxe7+ Nxe7 21. Qxd7+ Kxd7 22. Bf5+ Ke8 23. Bd7+ Kf8 24. Bxe7#';

test('Load -> Analyze -> Generate Cinematic replaces the timeline, and every existing control keeps working', async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
  page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));

  await page.goto('/');
  await page.waitForSelector('#pgn-input');

  // Evergreen Game preferred per Phase 2.4/2.5's own established fixtures —
  // its real StoryPlan/CinematicPlan output (king-hunt archetype, a climax
  // beat, camera zoom) is already proven meaningful.
  await page.fill('#pgn-input', EVERGREEN);
  await page.click('#load-btn');
  await expect(page.locator('#error')).toHaveText('');
  await expect(page.locator('#move-indicator')).toHaveText('Move 1 / 47 · 0.0s / 28.2s');

  // Generate Cinematic must be disabled until analysis completes.
  await expect(page.locator('#direct-btn')).toBeDisabled();

  const analyzeStart = Date.now();
  await page.click('#analyze-btn');
  await page.waitForFunction(
    () => document.querySelector('#analysis-status')?.textContent?.startsWith('Analysis complete') ?? false,
    { timeout: 120_000 }
  );
  const analyzeMs = Date.now() - analyzeStart;

  await expect(page.locator('#direct-btn')).toBeEnabled();

  const directStart = Date.now();
  await page.click('#direct-btn');
  await page.waitForFunction(
    () => document.querySelector('#direction-status')?.textContent?.startsWith('Cinematic direction complete') ?? false,
    { timeout: 120_000 }
  );
  const directMs = Date.now() - directStart;

  // The cinematic timeline genuinely differs from the trivial one (Director's
  // pacing is not a flat 600ms/move) — the total duration changed, and
  // move-indicator reflects the new Timeline immediately.
  const indicatorAfterDirect = await page.locator('#move-indicator').innerText();
  expect(indicatorAfterDirect).toContain('/ 47');
  expect(indicatorAfterDirect).not.toContain('28.2s');
  expect(indicatorAfterDirect).toMatch(/0\.0s \/ \d+\.\d+s/);

  // Board still renders (no exception, non-blank) after the swap.
  const canvasNonBlank = await page.evaluate(() => {
    const canvas = document.querySelector('#board') as HTMLCanvasElement;
    const ctx = canvas.getContext('2d')!;
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    return Array.from(data).some((v, i) => i % 4 !== 3 && v !== 255);
  });
  expect(canvasNonBlank).toBe(true);

  // Next / Prev / Play-Pause / Restart against the NEW timeline.
  await page.click('#next-btn');
  await page.waitForTimeout(60);
  await expect(page.locator('#move-indicator')).toContainText('Move 2 / 47');

  await page.click('#prev-btn');
  await page.waitForTimeout(60);
  await expect(page.locator('#move-indicator')).toContainText('Move 1 / 47');

  await page.click('#play-btn');
  await expect(page.locator('#play-btn')).toHaveText('Pause');
  await page.waitForTimeout(500);
  const duringPlay = await page.locator('#move-indicator').innerText();
  expect(duringPlay).not.toContain('0.0s');
  await page.click('#play-btn');
  await expect(page.locator('#play-btn')).toHaveText('Play');

  await page.click('#restart-btn');
  await page.waitForTimeout(60);
  await expect(page.locator('#move-indicator')).toContainText('0.0s');

  // Export still works against the cinematic timeline.
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 30_000 }), page.click('#export-btn')]);
  expect(download.suggestedFilename()).toBe('chess-cinema-export.zip');
  await expect(page.locator('#export-progress')).toHaveText('Export complete.');

  // Loading a second game resets Direction to idle and gives the new game
  // its own fresh trivial timeline, exactly like Analysis already resets.
  await page.fill('#pgn-input', '1. e4 e5 2. Nf3 Nc6');
  await page.click('#load-btn');
  await page.waitForTimeout(150);
  await expect(page.locator('#direction-status')).toHaveText('');
  await expect(page.locator('#direct-btn')).toBeDisabled();
  await expect(page.locator('#move-indicator')).toHaveText('Move 1 / 4 · 0.0s / 2.4s');

  expect(consoleErrors).toEqual([]);

  // Reported per Phase 2.5's own requirement — observed only, not asserted
  // against a budget (no premature performance optimization).
  console.log(`[Phase 2.5 timing] Analyze Game: ${analyzeMs}ms, Generate Cinematic: ${directMs}ms`);
});
