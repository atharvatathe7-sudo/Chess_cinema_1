import { expect, test } from '@playwright/test';

/**
 * Phase 2.1 integration: the REAL Stockfish WASM engine, in a real Worker, in
 * real Chromium. Deliberately separate from the pure unit tests, which script
 * their evaluations — these tests prove the engine actually loads and
 * communicates, without asserting specific evaluation numbers that would
 * break on any future engine build.
 */

// Loading and running a 7 MB WASM engine over a whole game is slower than the
// rest of the suite; these tests get their own budget.
test.describe.configure({ timeout: 180_000 });

async function loadShortGame(page: import('@playwright/test').Page, pgn: string): Promise<void> {
  await page.goto('/');
  await page.locator('#pgn-input').fill(pgn);
  await page.locator('#load-btn').click();
  await expect(page.locator('#error')).toHaveText('');
}

test('analyzes a short game with the real engine and lists ranked candidates', async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on('pageerror', (e) => consoleErrors.push(String(e)));

  // A short game containing a real, large blunder: after 1.e4 e5 2.Nf3 Nc6
  // 3.Bc4 Nd4, White's 4.Nxe5 loses material to 4...Qg5.
  await loadShortGame(page, '1. e4 e5 2. Nf3 Nc6 3. Bc4 Nd4 4. Nxe5 Qg5');

  await page.locator('#analyze-btn').click();

  // Progress must actually appear — proving work is streaming back from the worker.
  await expect(page.locator('#analysis-status')).toContainText(/Analyzing \d+ \/ \d+/, { timeout: 90_000 });

  await expect(page.locator('#analysis-status')).toContainText('Analysis complete', { timeout: 150_000 });
  // 1.e4 e5 2.Nf3 Nc6 3.Bc4 Nd4 4.Nxe5 Qg5 is 8 plies.
  await expect(page.locator('#analysis-status')).toContainText('8 moves');

  // Candidate section rendered (either real candidates, or an explicit "none").
  await expect(page.locator('#analysis-candidates')).not.toBeEmpty();

  expect(consoleErrors).toEqual([]);
});

test('the UI stays responsive while analysis runs, and Cancel stops it', async ({ page }) => {
  await loadShortGame(page, '1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5 7. Bb3 d6');

  await page.locator('#analyze-btn').click();
  await expect(page.locator('#analysis-status')).toContainText(/Analyzing \d+ \/ \d+/, { timeout: 90_000 });

  // Playback controls must still work mid-analysis — the engine is on a
  // worker thread, so the main thread is not blocked.
  await page.locator('#next-btn').click();
  await expect(page.locator('#move-indicator')).toContainText('Move 2 /');

  await expect(page.locator('#cancel-analysis-btn')).toBeEnabled();
  await page.locator('#cancel-analysis-btn').click();

  // Cancelling returns to an idle, re-runnable state rather than hanging.
  await expect(page.locator('#analyze-btn')).toHaveText('Analyze Game', { timeout: 30_000 });
  await expect(page.locator('#analyze-btn')).toBeEnabled();
  await expect(page.locator('#cancel-analysis-btn')).toBeDisabled();
});

test('engine evaluations obey the white-relative sign convention', async ({ page }) => {
  await page.goto('/');

  // Drive the engine directly and check the sign convention end to end: the
  // same lopsided position, with each side to move, must evaluate with the
  // same sign, because our convention is white-relative regardless of turn.
  const result = await page.evaluate(async () => {
    // Imported by runtime path (the dev server serves the module) rather than
    // a static specifier, which the test's own tsconfig cannot resolve.
    const modulePath = '/src/analysis/StockfishAnalysisEngine.ts';
    const mod = (await import(/* @vite-ignore */ modulePath)) as {
      StockfishAnalysisEngine: new () => {
        init(): Promise<{ ok: boolean; error?: { message: string } }>;
        evaluatePosition(
          fen: string,
          settings: { depth: number; maxTimeMsPerPosition: number }
        ): Promise<{ ok: boolean; value?: { evaluation: unknown }; error?: { message: string } }>;
        dispose(): void;
      };
    };
    const engine = new mod.StockfishAnalysisEngine();
    const init = await engine.init();
    if (!init.ok) return { error: init.error?.message ?? 'init failed' };

    const settings = { depth: 8, maxTimeMsPerPosition: 20000 };
    // White is a queen up. White to move, then the same material with Black to move.
    const whiteToMove = await engine.evaluatePosition('4k3/8/8/8/8/8/8/3QK3 w - - 0 1', settings);
    const blackToMove = await engine.evaluatePosition('4k3/8/8/8/8/8/8/3QK3 b - - 0 1', settings);
    engine.dispose();

    return {
      whiteToMove: whiteToMove.ok
        ? whiteToMove.value!.evaluation
        : { error: whiteToMove.error?.message },
      blackToMove: blackToMove.ok
        ? blackToMove.value!.evaluation
        : { error: blackToMove.error?.message }
    };
  });

  expect(result.error).toBeUndefined();
  const white = result.whiteToMove as { kind: string; cp?: number; mateIn?: number };
  const black = result.blackToMove as { kind: string; cp?: number; mateIn?: number };

  // White is winning in both, so both must be POSITIVE white-relative,
  // even though the engine reported the second one from Black's perspective.
  const asNumber = (e: typeof white): number =>
    e.kind === 'mate' ? (e.mateIn as number) : (e.cp as number);
  expect(asNumber(white)).toBeGreaterThan(0);
  expect(asNumber(black)).toBeGreaterThan(0);
});
