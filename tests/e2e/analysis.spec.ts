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

test('a broken engine payload produces a diagnosable error, not a bare timeout', async ({ page }) => {
  // Regression coverage for the Android "Analysis engine failed to load"
  // report: corrupt the inline engine payload the way build-artifact.mjs's
  // output is consumed (window.__CHESS_CINEMA_ENGINE__) so init() takes the
  // exact same code path the Artifact build uses, then assert the resulting
  // AppError actually says something — proving worker.onerror and the
  // handshake-stage tracking added to StockfishAnalysisEngine do their job
  // instead of leaving a bare "engine handshake timed out".
  await page.addInitScript(() => {
    (window as unknown as { __CHESS_CINEMA_ENGINE__: unknown }).__CHESS_CINEMA_ENGINE__ = {
      glue: 'this is not valid javascript {{{',
      wasmBase64: btoa('not a real wasm module')
    };
  });
  await page.goto('/');

  const result = await page.evaluate(async () => {
    const modulePath = '/src/analysis/StockfishAnalysisEngine.ts';
    const mod = (await import(/* @vite-ignore */ modulePath)) as {
      StockfishAnalysisEngine: new () => {
        init(): Promise<{ ok: boolean; error?: { message: string; cause?: unknown } }>;
        dispose(): void;
      };
    };
    const engine = new mod.StockfishAnalysisEngine();
    const init = await engine.init();
    engine.dispose();
    if (init.ok) return { ok: true as const };
    const cause = init.error?.cause;
    return {
      ok: false as const,
      message: init.error?.message,
      causeText: cause instanceof Error ? cause.message : String(cause)
    };
  });

  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.message).toBe('The analysis engine failed to load. Game analysis is unavailable.');
    // The old behaviour was a bare "engine handshake timed out" with no way
    // to tell a broken payload from a slow one. A syntactically invalid
    // glue script must fail fast via worker.onerror with real detail, not
    // silently run out the 30s handshake clock.
    expect(result.causeText).not.toBe('engine handshake timed out');
    expect(result.causeText.length).toBeGreaterThan(0);
  }
});

test('analysis works under a CSP that allows worker-src blob: but not connect-src blob:', async ({ page }) => {
  // Reproduces the exact restriction the Android Artifact diagnostic found:
  // Worker creation from a blob: URL succeeds, but a fetch() to a blob: URL
  // issued from *inside* that worker is blocked, because worker-src and
  // connect-src are independent CSP directives. This applies a real HTTP
  // Content-Security-Policy header (not a meta tag) so Chromium's own CSP
  // engine enforces it against the worker's internal fetch, the same way it
  // does in the Artifact sandbox — proving engineAssets.ts's fetch-intercept
  // prelude genuinely avoids that network path rather than merely working
  // around it in an environment where the restriction never applied.
  await page.route('**/*', async (route) => {
    const request = route.request();
    if (request.resourceType() !== 'document') {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    await route.fulfill({
      response,
      headers: {
        ...response.headers(),
        'content-security-policy': "connect-src 'self'; worker-src blob: 'self';"
      }
    });
  });

  await loadShortGame(page, '1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O');

  await page.locator('#analyze-btn').click();
  await expect(page.locator('#analysis-status')).toContainText('Analysis complete', { timeout: 60_000 });
  await expect(page.locator('#analysis-status')).not.toContainText('failed to load');
});
