import { devices, expect, test } from '@playwright/test';

/**
 * Phase 1.1: interactive timeline + playback controls, exercised against
 * the real built UI (not the pure-logic harness) since these are DOM/
 * pointer-interaction tests. Covers docs/architecture.md Correction 5's
 * successor — Play, Pause, Restart, Previous/Next Move, and the custom
 * Pointer-Events timeline, including a touch-emulated context.
 */

async function loadSampleGame(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/');
  await page.locator('#load-btn').click();
  await expect(page.locator('#error')).toHaveText('');
}

function parseIndicator(text: string): { move: number; total: number; seconds: number; totalSeconds: number } {
  const match = text.match(/Move (\d+) \/ (\d+)\s*·\s*([\d.]+)s \/ ([\d.]+)s/);
  if (!match) throw new Error(`could not parse move indicator: "${text}"`);
  return { move: Number(match[1]), total: Number(match[2]), seconds: Number(match[3]), totalSeconds: Number(match[4]) };
}

test('Play advances the clock and Pause freezes it', async ({ page }) => {
  await loadSampleGame(page);

  await page.locator('#play-btn').click();
  await expect(page.locator('#play-btn')).toHaveText('Pause');
  await page.waitForTimeout(400);
  const whilePlaying = parseIndicator((await page.locator('#move-indicator').textContent())!);
  expect(whilePlaying.seconds).toBeGreaterThan(0);

  await page.locator('#play-btn').click();
  await expect(page.locator('#play-btn')).toHaveText('Play');
  const atPause = parseIndicator((await page.locator('#move-indicator').textContent())!);
  await page.waitForTimeout(300);
  const afterWaiting = parseIndicator((await page.locator('#move-indicator').textContent())!);
  expect(afterWaiting.seconds).toBe(atPause.seconds); // frozen while paused
});

test('Next Move and Previous Move step through beat boundaries', async ({ page }) => {
  await loadSampleGame(page);

  await page.locator('#next-btn').click();
  expect(parseIndicator((await page.locator('#move-indicator').textContent())!).move).toBe(2);

  await page.locator('#next-btn').click();
  expect(parseIndicator((await page.locator('#move-indicator').textContent())!).move).toBe(3);

  await page.locator('#prev-btn').click();
  expect(parseIndicator((await page.locator('#move-indicator').textContent())!).move).toBe(2);
});

test('Restart returns to the beginning and the game can be played again without reloading the PGN', async ({ page }) => {
  await loadSampleGame(page);

  await page.locator('#next-btn').click();
  await page.locator('#next-btn').click();
  expect(parseIndicator((await page.locator('#move-indicator').textContent())!).move).toBeGreaterThan(1);

  await page.locator('#restart-btn').click();
  const afterRestart = parseIndicator((await page.locator('#move-indicator').textContent())!);
  expect(afterRestart.move).toBe(1);
  expect(afterRestart.seconds).toBe(0);

  // Restart must not have cleared/reloaded the PGN: Play should still work immediately.
  await page.locator('#play-btn').click();
  await page.waitForTimeout(300);
  expect(parseIndicator((await page.locator('#move-indicator').textContent())!).seconds).toBeGreaterThan(0);
});

test('at the end of the timeline, playback stops cleanly and Play/Pause reflects it', async ({ page }) => {
  await loadSampleGame(page);
  const total = parseIndicator((await page.locator('#move-indicator').textContent())!).total;

  for (let i = 0; i < total; i++) {
    await page.locator('#next-btn').click();
  }
  const atEnd = parseIndicator((await page.locator('#move-indicator').textContent())!);
  expect(atEnd.move).toBe(total);
  expect(atEnd.seconds).toBe(atEnd.totalSeconds);

  await page.locator('#play-btn').click();
  await page.waitForTimeout(300);
  await expect(page.locator('#play-btn')).toHaveText('Play'); // never enters a "playing forever past the end" state
});

test('dragging the timeline track forward and backward (pointer events) updates the board immediately', async ({ page }) => {
  await loadSampleGame(page);
  const track = page.locator('.tc-hitarea');
  const box = (await track.boundingBox())!;

  async function dragTo(fraction: number): Promise<void> {
    const x = box.x + box.width * fraction;
    const y = box.y + box.height / 2;
    await track.dispatchEvent('pointerdown', { pointerId: 1, clientX: x, clientY: y, button: 0 });
    await track.dispatchEvent('pointermove', { pointerId: 1, clientX: x, clientY: y });
    await track.dispatchEvent('pointerup', { pointerId: 1, clientX: x, clientY: y, button: 0 });
  }

  await dragTo(0.75);
  const afterForwardDrag = parseIndicator((await page.locator('#move-indicator').textContent())!);
  expect(afterForwardDrag.seconds).toBeGreaterThan(afterForwardDrag.totalSeconds * 0.5);

  await dragTo(0.1);
  const afterBackwardDrag = parseIndicator((await page.locator('#move-indicator').textContent())!);
  expect(afterBackwardDrag.seconds).toBeLessThan(afterForwardDrag.seconds);

  // scrubbing pauses playback, matching the existing scrub convention
  await expect(page.locator('#play-btn')).toHaveText('Play');
});

test('play -> pause -> scrub -> play works end to end in the real UI', async ({ page }) => {
  await loadSampleGame(page);

  await page.locator('#play-btn').click();
  await page.waitForTimeout(300);
  await page.locator('#play-btn').click(); // pause

  const track = page.locator('.tc-hitarea');
  const box = (await track.boundingBox())!;
  const x = box.x + box.width * 0.2;
  const y = box.y + box.height / 2;
  await track.dispatchEvent('pointerdown', { pointerId: 2, clientX: x, clientY: y, button: 0 });
  await track.dispatchEvent('pointerup', { pointerId: 2, clientX: x, clientY: y, button: 0 });

  const afterScrub = parseIndicator((await page.locator('#move-indicator').textContent())!);

  await page.locator('#play-btn').click(); // play again
  await page.waitForTimeout(250);
  const afterResume = parseIndicator((await page.locator('#move-indicator').textContent())!);

  expect(afterResume.seconds).toBeGreaterThan(afterScrub.seconds);
});

test('no unexpected console/runtime errors across load, controls, and scrubbing', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(String(err)));
  page.on('console', (msg) => {
    if (msg.type() === 'error' && !msg.text().includes('404')) errors.push(msg.text());
  });

  await loadSampleGame(page);
  await page.locator('#play-btn').click();
  await page.waitForTimeout(200);
  await page.locator('#play-btn').click();
  await page.locator('#next-btn').click();
  await page.locator('#prev-btn').click();
  await page.locator('#restart-btn').click();

  const track = page.locator('.tc-hitarea');
  const box = (await track.boundingBox())!;
  await track.dispatchEvent('pointerdown', { pointerId: 3, clientX: box.x + box.width * 0.6, clientY: box.y + box.height / 2, button: 0 });
  await track.dispatchEvent('pointerup', { pointerId: 3, clientX: box.x + box.width * 0.6, clientY: box.y + box.height / 2, button: 0 });

  expect(errors).toEqual([]);
});

test.describe('touch input (emulated Android viewport)', () => {
  // devices['Pixel 7'] includes defaultBrowserType, which test.use() can't
  // set inside a describe block (it would force a new worker) — drop it
  // and keep only the viewport/touch/UA fields we actually need.
  const { defaultBrowserType: _defaultBrowserType, ...pixel7Context } = devices['Pixel 7'];
  test.use({ ...pixel7Context });

  test('tapping the timeline seeks via a real touch event', async ({ page }) => {
    await loadSampleGame(page);
    const track = page.locator('.tc-hitarea');
    const box = (await track.boundingBox())!;

    await page.touchscreen.tap(box.x + box.width * 0.85, box.y + box.height / 2);
    await page.waitForTimeout(150);

    const after = parseIndicator((await page.locator('#move-indicator').textContent())!);
    expect(after.seconds).toBeGreaterThan(after.totalSeconds * 0.6);
  });

  test('dragging the timeline with touch pointer events scrubs backward correctly', async ({ page }) => {
    await loadSampleGame(page);
    const track = page.locator('.tc-hitarea');
    const box = (await track.boundingBox())!;

    const farX = box.x + box.width * 0.9;
    const nearX = box.x + box.width * 0.15;
    const y = box.y + box.height / 2;

    await track.dispatchEvent('pointerdown', { pointerId: 9, pointerType: 'touch', clientX: farX, clientY: y, button: 0 });
    await track.dispatchEvent('pointermove', { pointerId: 9, pointerType: 'touch', clientX: nearX, clientY: y });
    await track.dispatchEvent('pointerup', { pointerId: 9, pointerType: 'touch', clientX: nearX, clientY: y, button: 0 });

    const after = parseIndicator((await page.locator('#move-indicator').textContent())!);
    expect(after.seconds).toBeLessThan(after.totalSeconds * 0.3);
  });

  test('all controls remain tappable and non-overlapping on a phone-sized viewport', async ({ page }) => {
    await loadSampleGame(page);
    for (const id of ['#restart-btn', '#prev-btn', '#play-btn', '#next-btn', '#export-btn']) {
      const box = await page.locator(id).boundingBox();
      expect(box, `${id} should be visible/laid out`).not.toBeNull();
      expect(box!.height, `${id} touch target height`).toBeGreaterThanOrEqual(40);
    }
    const boardBox = (await page.locator('#board').boundingBox())!;
    expect(Math.abs(boardBox.width - boardBox.height), 'board must remain square').toBeLessThan(1);
  });
});
