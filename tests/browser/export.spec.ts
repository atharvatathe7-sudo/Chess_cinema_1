import { expect, test } from '@playwright/test';

const PGN = '1. e4 e5 2. Nf3 Nc6';
const DIMS = { width: 150, height: 150 };

test.beforeEach(async ({ page }) => {
  await page.goto('/tests/fixtures/harness.html');
  await page.evaluate(() => (window as any).__harness.ready());
});

test('export produces byte-identical output across two independent runs of the same state', async ({ page }) => {
  const { a, b } = await page.evaluate(
    async ({ pgn, dims }) => {
      const h = (window as any).__harness;
      const a = await h.hashExportOnce(pgn, dims, 10);
      const b = await h.hashExportOnce(pgn, dims, 10);
      return { a, b };
    },
    { pgn: PGN, dims: DIMS }
  );

  expect(a).toBe(b);
});

test("export never holds more than one frame's pixels in flight at a time (bounded memory)", async ({ page }) => {
  const peakInFlight = await page.evaluate(
    ({ pgn, dims }) => (window as any).__harness.exportPeakFramesInFlight(pgn, dims, 10),
    { pgn: PGN, dims: DIMS }
  );

  expect(peakInFlight).toBe(1);
});
