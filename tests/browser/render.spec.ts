import { expect, test } from '@playwright/test';

const PGN = '1. e4 e5 2. Nf3 Nc6';

test.beforeEach(async ({ page }) => {
  await page.goto('/tests/fixtures/harness.html');
  await page.evaluate(() => (window as any).__harness.ready());
});

test('renders a non-blank frame once a game is loaded', async ({ page }) => {
  const hash = await page.evaluate(({ pgn }) => {
    const h = (window as any).__harness;
    const state = h.buildFixtureState(pgn);
    h.renderDirect('canvas-a', state, 0);
    return h.hashCanvas('canvas-a');
  }, { pgn: PGN });

  // A blank canvas has a well-known hash for an all-transparent-black buffer;
  // a real board should not match it (weak but effective smoke check).
  const blankHash = await page.evaluate(() => (window as any).__harness.hashCanvas('canvas-b'));
  expect(hash).not.toBe(blankHash);
});

test('is deterministic: identical (state, time) renders identical pixels', async ({ page }) => {
  const [hashA, hashB] = await page.evaluate(({ pgn }) => {
    const h = (window as any).__harness;
    const state = h.buildFixtureState(pgn);
    h.renderDirect('canvas-a', state, 300);
    const a = h.hashCanvas('canvas-a');
    h.renderDirect('canvas-a', state, 300);
    const b = h.hashCanvas('canvas-a');
    return [a, b];
  }, { pgn: PGN });

  expect(hashA).toBe(hashB);
});

test('excludes the moving piece from the static layer while animating (mid-move frame differs from settled frame)', async ({ page }) => {
  const { midHash, settledHash } = await page.evaluate(({ pgn }) => {
    const h = (window as any).__harness;
    const state = h.buildFixtureState(pgn);
    h.renderDirect('canvas-a', state, 300); // mid-flight (MOVE_DURATION_MS=600)
    const midHash = h.hashCanvas('canvas-a');
    h.renderDirect('canvas-a', state, 600); // settled at the end of move 1
    const settledHash = h.hashCanvas('canvas-a');
    return { midHash, settledHash };
  }, { pgn: PGN });

  expect(midHash).not.toBe(settledHash);
});
