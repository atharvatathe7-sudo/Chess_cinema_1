import { expect, test } from '@playwright/test';

/**
 * Phase 5 — real video export. Chromium is this project's documented
 * target browser (see playwright.config.ts), so this is where the actual
 * WebCodecs VP9 encode + WebmMuxer container assembly is exercised for
 * real — the muxer's own container/timing correctness is already covered
 * in isolation by WebmMuxer.test.ts (Vitest/Node); this file's job is to
 * prove the two halves actually produce a file a real browser will load
 * and play, end to end through the real UI.
 */

test.describe.configure({ timeout: 180_000 });

// The Evergreen Game — deliberately used here (not Scholar's Mate) because
// its longer cinematic timeline (~410 frames at 24fps) exercises the
// multi-Cluster path in WebmMuxer, not just a single short cluster.
const EVERGREEN =
  '1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. b4 Bxb4 5. c3 Ba5 6. d4 exd4 7. O-O d3 8. Qb3 Qf6 9. e5 Qg6 10. Re1 Nge7 11. Ba3 b5 12. Qxb5 Rb8 13. Qa4 Bb6 14. Nbd2 Bb7 15. Ne4 Qf5 16. Bxd3 Qh5 17. Nf6+ gxf6 18. exf6 Rg8 19. Rad1 Qxf3 20. Rxe7+ Nxe7 21. Qxd7+ Kxd7 22. Bf5+ Ke8 23. Bd7+ Kf8 24. Bxe7#';

async function loadAnalyzeDirect(page: import('@playwright/test').Page, pgn: string): Promise<void> {
  await page.goto('/');
  await page.waitForSelector('#pgn-input');
  await page.fill('#pgn-input', pgn);
  await page.click('#load-btn');
  await expect(page.locator('#error')).toHaveText('');

  await page.click('#analyze-btn');
  await page.waitForFunction(() => (document.querySelector('#analysis-status')?.textContent ?? '').startsWith('Analysis complete'), {
    timeout: 120_000
  });

  await page.click('#direct-btn');
  await page.waitForFunction(() => (document.querySelector('#direction-status')?.textContent ?? '').startsWith('Cinematic direction complete'), {
    timeout: 120_000
  });
}

/** Parses "Move 46 / 47  ·  16.7s / 17.1s" -> 17.1 (the total duration in seconds already displayed by the real UI, used as this test's own ground truth rather than a hardcoded duration). */
function parseTotalDurationSeconds(moveIndicatorText: string): number {
  const match = moveIndicatorText.match(/\/\s*([\d.]+)s\s*$/);
  if (!match) throw new Error(`could not parse total duration out of move-indicator text: "${moveIndicatorText}"`);
  return Number(match[1]);
}

test('Export Video produces a real, playable WebM for the Evergreen Game', async ({ page }) => {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => pageErrors.push(String(err)));

  await loadAnalyzeDirect(page, EVERGREEN);

  const exportVideoBtn = page.locator('#export-video-btn');
  const exportProgress = page.locator('#export-progress');

  // Capability detection is async (VideoEncoder.isConfigSupported) — give
  // it a moment to resolve and enable the button, same as any other
  // async-enabled control in this UI.
  await expect(exportVideoBtn).toBeEnabled({ timeout: 15_000 });

  const expectedDurationSeconds = parseTotalDurationSeconds((await page.locator('#move-indicator').textContent()) ?? '');
  expect(expectedDurationSeconds).toBeGreaterThan(0);

  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 60_000 }), exportVideoBtn.click()]);

  expect(download.suggestedFilename()).toBe('chess-cinema-export.webm');
  await expect(exportProgress).toHaveText('Export complete.');

  const downloadPath = await download.path();
  expect(downloadPath).not.toBeNull();

  const fs = await import('node:fs/promises');
  const bytes = await fs.readFile(downloadPath!);
  expect(bytes.length).toBeGreaterThan(0);

  // WebM/EBML signature: the file must start with the EBML header ID
  // (0x1A45DFA3) — a real, structural check, not just "some bytes exist".
  expect(bytes.subarray(0, 4).toString('hex')).toBe('1a45dfa3');

  // Hand the bytes to a real <video> element in the real browser and
  // confirm it actually loads as playable video — the one thing only a
  // real browser (not the unit tests) can prove.
  const base64 = bytes.toString('base64');
  const metadata = await page.evaluate(async (b64) => {
    const binary = atob(b64);
    const raw = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) raw[i] = binary.charCodeAt(i);
    const blob = new Blob([raw as BlobPart], { type: 'video/webm' });
    const url = URL.createObjectURL(blob);
    const video = document.createElement('video');
    video.src = url;
    document.body.appendChild(video);
    try {
      await new Promise<void>((resolve, reject) => {
        video.addEventListener('loadedmetadata', () => resolve(), { once: true });
        video.addEventListener('error', () => reject(new Error(`video element failed to load: ${video.error?.message ?? 'unknown error'}`)), { once: true });
        setTimeout(() => reject(new Error('timed out waiting for loadedmetadata')), 15_000);
      });
      return { duration: video.duration, videoWidth: video.videoWidth, videoHeight: video.videoHeight };
    } finally {
      URL.revokeObjectURL(url);
      video.remove();
    }
  }, base64);

  expect(metadata.duration).toBeGreaterThan(0);
  expect(metadata.videoWidth).toBeGreaterThan(0);
  expect(metadata.videoHeight).toBeGreaterThan(0);

  // Generous tolerance (1s) — the container's own duration is inferred
  // from the final frame's gap to the previous one (see WebmMuxer's
  // documented approximation) and browsers can round video.duration
  // slightly; this is checking "matches the cinematic plan", not
  // asserting frame-exact equality (that belongs to WebmMuxer.test.ts,
  // which checks the container bytes directly and deterministically).
  //
  // Phase 12A — the Evergreen Game ends in checkmate (24. Bxe7#), so
  // export/runExport.ts now appends a fixed extra terminal-caption hold
  // (1.5s) after the game's own natural end, extending real exported
  // seconds beyond expectedDurationSeconds (read from the Timeline's own,
  // unmodified scene.durationMs) — see export/runExport.ts's own
  // TERMINAL_HOLD_MS and tests/e2e/terminalHold.spec.ts for dedicated
  // coverage of that behavior. This test's own job is only "is this a
  // normal, playable WebM", so the tolerance is simply widened by that
  // same fixed amount rather than re-deriving TERMINAL_HOLD_MS's own value
  // here.
  const TERMINAL_HOLD_TOLERANCE_SECONDS = 1.5;
  const DURATION_TOLERANCE_SECONDS = 1 + TERMINAL_HOLD_TOLERANCE_SECONDS;
  expect(Math.abs(metadata.duration - expectedDurationSeconds)).toBeLessThanOrEqual(DURATION_TOLERANCE_SECONDS);

  expect(consoleErrors).toEqual([]);
  expect(pageErrors).toEqual([]);
});

test('Export PNG sequence still works after Export Video is used, and vice versa', async ({ page }) => {
  await loadAnalyzeDirect(page, EVERGREEN);

  const exportBtn = page.locator('#export-btn');
  const exportProgress = page.locator('#export-progress');

  const [pngDownload] = await Promise.all([page.waitForEvent('download', { timeout: 60_000 }), exportBtn.click()]);
  expect(pngDownload.suggestedFilename()).toBe('chess-cinema-export.zip');
  await expect(exportProgress).toHaveText('Export complete.');

  const exportVideoBtn = page.locator('#export-video-btn');
  await expect(exportVideoBtn).toBeEnabled({ timeout: 15_000 });
  const [videoDownload] = await Promise.all([page.waitForEvent('download', { timeout: 60_000 }), exportVideoBtn.click()]);
  expect(videoDownload.suggestedFilename()).toBe('chess-cinema-export.webm');
  await expect(exportProgress).toHaveText('Export complete.');

  // Neither export left the other button permanently disabled.
  await expect(page.locator('#export-btn')).toBeEnabled();
  await expect(exportVideoBtn).toBeEnabled();
});
