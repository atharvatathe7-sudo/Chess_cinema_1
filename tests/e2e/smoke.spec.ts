import { expect, test } from '@playwright/test';

/**
 * The one end-to-end test for Phase 1: load a PGN through the real UI,
 * play it, and export it — proving the whole pipeline wires together,
 * not just its individual pieces.
 */
test('load PGN, play, export a PNG sequence', async ({ page }) => {
  await page.goto('/');

  const loadBtn = page.locator('#load-btn');
  const playBtn = page.locator('#play-btn');
  const exportBtn = page.locator('#export-btn');
  const exportProgress = page.locator('#export-progress');
  const errorEl = page.locator('#error');

  // The textarea ships pre-filled with a sample PGN for Phase 1.
  await loadBtn.click();
  await expect(errorEl).toHaveText('');
  await expect(playBtn).toBeEnabled();
  await expect(exportBtn).toBeEnabled();

  await playBtn.click();
  await expect(playBtn).toHaveText('Pause');
  await page.waitForTimeout(300);
  await playBtn.click();
  await expect(playBtn).toHaveText('Play');

  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 30_000 }),
    exportBtn.click()
  ]);

  expect(download.suggestedFilename()).toBe('chess-cinema-export.zip');
  await expect(exportProgress).toHaveText('Export complete.');
});

test('shows a recoverable error for malformed PGN without crashing the app', async ({ page }) => {
  await page.goto('/');

  await page.locator('#pgn-input').fill('this is not a pgn');
  await page.locator('#load-btn').click();

  await expect(page.locator('#error')).not.toHaveText('');
  await expect(page.locator('#play-btn')).toBeDisabled();
});
