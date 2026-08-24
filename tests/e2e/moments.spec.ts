import { expect, test } from '@playwright/test';

/**
 * Phase 2.6 — Cinematic Moments navigation. The real-browser regression
 * target this file exists for: timeline/navigation.ts's ordinary Next Move
 * still lands exactly on scene.durationMs once overshot past the last
 * move (unchanged, on purpose — see moments.ts's own comment), which is
 * exactly the boundary where the final move's own annotations
 * (render/drawAnnotations.ts's `logicalTimeMs >= beat.untilMs` exclusion)
 * are provably off. "Next Moment" is a separate, additive way to land
 * strictly inside that same window instead. This file proves the two are
 * genuinely different in the real, running app — not merely that a
 * timestamp number differs, but that the rendered pixels differ.
 */

test.describe.configure({ timeout: 180_000 });

const SCHOLARS_MATE = '1. e4 e5 2. Bc4 Bc5 3. Qh5 Nf6 4. Qxf7#';
const EVERGREEN =
  '1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. b4 Bxb4 5. c3 Ba5 6. d4 exd4 7. O-O d3 8. Qb3 Qf6 9. e5 Qg6 10. Re1 Nge7 11. Ba3 b5 12. Qxb5 Rb8 13. Qa4 Bb6 14. Nbd2 Bb7 15. Ne4 Qf5 16. Bxd3 Qh5 17. Nf6+ gxf6 18. exf6 Rg8 19. Rad1 Qxf3 20. Rxe7+ Nxe7 21. Qxd7+ Kxd7 22. Bf5+ Ke8 23. Bd7+ Kf8 24. Bxe7#';
const STALEMATE = '1. e3 a5 2. Qh5 Ra6 3. Qxa5 h5 4. Qxc7 Rah6 5. h4 f6 6. Qxd7+ Kf7 7. Qxb7 Qd3 8. Qxb8 Qh7 9. Qxc8 Kg6 10. Qe6';

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

async function canvasPixels(page: import('@playwright/test').Page): Promise<number[]> {
  return page.evaluate(() => {
    const canvas = document.querySelector('#board') as HTMLCanvasElement;
    const ctx = canvas.getContext('2d')!;
    return Array.from(ctx.getImageData(0, 0, canvas.width, canvas.height).data);
  });
}

function sumAbsDiff(a: number[], b: number[]): number {
  let total = 0;
  for (let i = 0; i < a.length; i++) total += Math.abs(a[i]! - (b[i] ?? 0));
  return total;
}

test('Scholar\'s Mate: Next Move overshoot still hides the terminal highlight, but Next Moment reliably shows it', async ({ page }) => {
  await loadAnalyzeDirect(page, SCHOLARS_MATE);

  // Moments UI appears and correctly identifies the checkmate — however
  // many total moments this game produces (its archetype/central-conflict
  // detection is exercised and asserted elsewhere; this test only relies
  // on there being exactly one Checkmate-labeled entry, which is
  // guaranteed since terminal-result-highlight fires at most once, on the
  // game's own final ply).
  await expect(page.locator('#moments-section')).toBeVisible();
  const momentButtons = page.locator('#moments-list button.moment-btn');
  await expect(momentButtons.first()).toBeVisible();
  const checkmateButton = page.locator('#moments-list button.moment-btn', { hasText: 'Checkmate' });
  await expect(checkmateButton).toHaveCount(1);
  await expect(checkmateButton).toContainText('Move 7');

  // Phase 2.7: every moment shows a non-empty, factual reason, and the
  // checkmate moment specifically shows the exact checkmate reason.
  const listItems = page.locator('#moments-list li');
  await expect(listItems.first().locator('.moment-reason')).not.toBeEmpty();
  const checkmateItem = page.locator('#moments-list li', { hasText: 'Checkmate' });
  await expect(checkmateItem.locator('.moment-reason')).toHaveText('The game ended in checkmate.');

  // 1. Reproduce the OLD bug with ordinary Next Move, unchanged: Restart,
  // then step past the last move so nextBeatBoundaryMs's fallback lands
  // exactly on scene.durationMs.
  await page.click('#restart-btn');
  await page.waitForTimeout(30);
  for (let i = 0; i < 8; i++) {
    await page.click('#next-btn');
    await page.waitForTimeout(20);
  }
  const overshotIndicator = await page.locator('#move-indicator').innerText();
  expect(overshotIndicator).toContain('Move 7 / 7');
  expect(overshotIndicator).toContain('3.6s / 3.6s'); // at scene.durationMs — the exact dead zone
  const overshotPixels = await canvasPixels(page);

  // 2. The new, additive path: Restart, then click straight to the
  // Checkmate moment via the Moments list.
  await page.click('#restart-btn');
  await page.waitForTimeout(30);
  await checkmateButton.click();
  await page.waitForTimeout(30);
  const momentIndicator = await page.locator('#move-indicator').innerText();
  // The 1ms gap between targetTimeMs and scene.durationMs is not visible at
  // the indicator's own 1-decimal display precision — the pixel-diff
  // assertion below is the real, meaningful proof that this timestamp is
  // strictly inside the annotation window, not the displayed seconds text.
  expect(momentIndicator).toContain('Move 7 / 7');
  const momentPixels = await canvasPixels(page);

  // The terminal annotation is genuinely visible: the rendered frame at the
  // Next-Moment landing point is meaningfully different from the same
  // chess position reached via plain Next Move overshoot — proving
  // Next Move and Next Moment are NOT the same thing, and that the
  // highlight is actually painted, not merely that a timestamp differs.
  expect(sumAbsDiff(overshotPixels, momentPixels)).toBeGreaterThan(5000);

  // 3. Board never goes blank.
  const nonBlank = await page.evaluate(() => {
    const canvas = document.querySelector('#board') as HTMLCanvasElement;
    const ctx = canvas.getContext('2d')!;
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    return Array.from(data).some((v, i) => i % 4 !== 3 && v !== 255);
  });
  expect(nonBlank).toBe(true);

  // 4. Ordinary Previous/Next Move still work, completely unchanged, after
  // using Next Moment — Previous Move's own existing semantics (unmodified
  // timeline/navigation.ts) go to the start of the CURRENT move beat when
  // the playhead is already partway through it (the moment landed inside
  // move 7's own beat, not exactly at its start), so this only checks that
  // Prev/Next genuinely move the clock, not a specific move number.
  await page.click('#prev-btn');
  await page.waitForTimeout(30);
  const afterPrev = await page.locator('#move-indicator').innerText();
  expect(afterPrev).not.toBe(momentIndicator);
  await page.click('#next-btn');
  await page.waitForTimeout(30);
  const afterPrevThenNext = await page.locator('#move-indicator').innerText();
  expect(afterPrevThenNext).not.toBe(afterPrev);

  // 5. The Checkmate moment is provably the chronologically LAST one (its
  // ply — the game's own final ply — is the largest of any moment, and
  // atMs is non-decreasing in ply), so clicking Next Moment from it must
  // be a no-op: repeated clicks can never escape past scene.durationMs.
  await checkmateButton.click();
  await page.waitForTimeout(30);
  const atCheckmate = await page.locator('#move-indicator').innerText();
  await page.click('#next-moment-btn');
  await page.waitForTimeout(30);
  await page.click('#next-moment-btn');
  await page.waitForTimeout(30);
  const stillAtMoment = await page.locator('#move-indicator').innerText();
  expect(stillAtMoment).toBe(atCheckmate);
});

test('Evergreen: a central-conflict/archetype moment is navigable and Export still works afterward', async ({ page }) => {
  await loadAnalyzeDirect(page, EVERGREEN);

  await expect(page.locator('#moments-section')).toBeVisible();
  const momentButtons = page.locator('#moments-list button.moment-btn');
  const count = await momentButtons.count();
  expect(count).toBeGreaterThan(0);

  // Tightened (Phase 2.7): the previous /Climax|King Hunt|Checkmate/ regex
  // was satisfiable by the terminal Checkmate entry alone, so it never
  // actually proved a non-terminal central-conflict/archetype moment was
  // present. This game's real, source-verified output (confirmed this
  // session via a fresh real-browser run, not assumed) is exactly two
  // moments: "Forced Trap — Move 46" (a genuine archetype-track moment,
  // unrelated to the terminal highlight) and "Checkmate — Move 47". This
  // asserts the specific non-terminal one by exact text, with its reason.
  const forcedTrapButton = page.locator('#moments-list button.moment-btn', { hasText: 'Forced Trap' });
  await expect(forcedTrapButton).toHaveCount(1);
  await expect(forcedTrapButton).toContainText('Move 46');
  const forcedTrapItem = page.locator('#moments-list li', { hasText: 'Forced Trap' });
  await expect(forcedTrapItem.locator('.moment-reason')).toHaveText('A sacrifice forced a decisive sequence.');

  await page.click('#restart-btn');
  await page.waitForTimeout(30);
  const beforeIndicator = await page.locator('#move-indicator').innerText();

  await page.click('#next-moment-btn');
  await page.waitForTimeout(30);
  const afterIndicator = await page.locator('#move-indicator').innerText();
  expect(afterIndicator).not.toBe(beforeIndicator);

  // Clicking a moment in the list seeks directly, same mechanism.
  await momentButtons.first().click();
  await page.waitForTimeout(30);
  const afterListClick = await page.locator('#move-indicator').innerText();
  expect(afterListClick).not.toBe('Move 1 / 47  ·  0.0s / 17.1s');

  // Export is untouched by any of this — same behavior as before Phase 2.6.
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 60_000 }), page.click('#export-btn')]);
  expect(download.suggestedFilename()).toBe('chess-cinema-export.zip');
  await expect(page.locator('#export-progress')).toHaveText('Export complete.');
});

test('Stalemate: the terminal Moment shows the exact stalemate reason, distinct from checkmate', async ({ page }) => {
  await loadAnalyzeDirect(page, STALEMATE);

  await expect(page.locator('#moments-section')).toBeVisible();
  const stalemateButton = page.locator('#moments-list button.moment-btn', { hasText: 'Stalemate' });
  await expect(stalemateButton).toHaveCount(1);
  const stalemateItem = page.locator('#moments-list li', { hasText: 'Stalemate' });
  await expect(stalemateItem.locator('.moment-reason')).toHaveText('The game ended in a stalemate — a draw by no legal moves.');

  // Clicking it navigates correctly and the annotation is visibly rendered
  // (non-blank canvas — the pixel-level proof this differs from ordinary
  // Next Move overshoot is already covered by the Scholar's Mate test
  // above; this test's own job is the reason text, not re-proving that).
  await stalemateButton.click();
  await page.waitForTimeout(30);
  const nonBlank = await page.evaluate(() => {
    const canvas = document.querySelector('#board') as HTMLCanvasElement;
    const ctx = canvas.getContext('2d')!;
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    return Array.from(data).some((v, i) => i % 4 !== 3 && v !== 255);
  });
  expect(nonBlank).toBe(true);
});

test('Moments UI is hidden before Direction completes and resets after loading a new PGN', async ({ page }) => {
  await page.goto('/');
  await page.waitForSelector('#pgn-input');
  await page.fill('#pgn-input', SCHOLARS_MATE);
  await page.click('#load-btn');
  await expect(page.locator('#moments-section')).toBeHidden();

  await loadAnalyzeDirect(page, SCHOLARS_MATE);
  await expect(page.locator('#moments-section')).toBeVisible();

  // Loading a different PGN resets Direction (existing behavior) and, with
  // it, the Moments UI — no new reset logic was added; this follows
  // automatically from direction.status returning to 'idle'.
  await page.fill('#pgn-input', '1. e4 e5 2. Nf3 Nc6');
  await page.click('#load-btn');
  await page.waitForTimeout(100);
  await expect(page.locator('#moments-section')).toBeHidden();
});
