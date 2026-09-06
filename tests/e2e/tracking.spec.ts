import { expect, test, type Page } from '@playwright/test';

/**
 * Phase 18D Batch 1 — real-pipeline coverage for single-subject camera
 * tracking. Runs the actual analysis/direction pipeline (same technique
 * preClimaxRamp.spec.ts/terminalPayoffCamera.spec.ts already use) against
 * real canonical games, reads the real CinematicPlan.trackingDirectives and
 * the real, lowered Scene.cameraPlan.keyframes, and — the point of this
 * file — proves the camera actually MOVES across the tracked span rather
 * than merely asserting that tracking keyframes exist.
 */

test.describe.configure({ timeout: 180_000 });

const SCHOLARS_MATE = '1. e4 e5 2. Bc4 Bc5 3. Qh5 Nf6 4. Qxf7#';
const EVERGREEN =
  '1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. b4 Bxb4 5. c3 Ba5 6. d4 exd4 7. O-O d3 8. Qb3 Qf6 9. e5 Qg6 10. Re1 Nge7 11. Ba3 b5 12. Qxb5 Rb8 13. Qa4 Bb6 14. Nbd2 Bb7 15. Ne4 Qf5 16. Bxd3 Qh5 17. Nf6+ gxf6 18. exf6 Rg8 19. Rad1 Qxf3 20. Rxe7+ Nxe7 21. Qxd7+ Kxd7 22. Bf5+ Ke8 23. Bd7+ Kf8 24. Bxe7#';
const STALEMATE = '1. e3 a5 2. Qh5 Ra6 3. Qxa5 h5 4. Qxc7 Rah6 5. h4 f6 6. Qxd7+ Kf7 7. Qxb7 Qd3 8. Qxb8 Qh7 9. Qxc8 Kg6 10. Qe6';

async function loadAnalyzeDirect(page: Page, pgn: string): Promise<void> {
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

interface TrackingReadout {
  readonly trackingDirectives: readonly {
    fromPly: number;
    toPly: number;
    subject: { kind: string; pieceId: string };
    role: string;
    evidenceRef: { kind: string; ply: number };
  }[];
  readonly keyframes: readonly { atMs: number; centerX: number; centerY: number; zoom: number }[];
  readonly plyAtMsByPly: Readonly<Record<number, number>>;
}

async function analyzeTracking(page: Page, pgn: string): Promise<TrackingReadout> {
  await loadAnalyzeDirect(page, pgn);
  return page.evaluate(async (pgn) => {
    // Vite dev-server absolute module specifiers, resolved in-browser at
    // runtime — not resolvable by tsc. Same technique preClimaxRamp.spec.ts
    // already uses to query the real live pipeline.
    // @ts-expect-error — Vite-only absolute module specifier
    const { ChessJsEngine } = await import('/src/chess/ChessJsEngine.ts');
    // @ts-expect-error — Vite-only absolute module specifier
    const { createInitialState } = await import('/src/state/AppState.ts');
    // @ts-expect-error — Vite-only absolute module specifier
    const { Store } = await import('/src/state/store.ts');
    // @ts-expect-error — Vite-only absolute module specifier
    const { loadPgn } = await import('/src/state/actions.ts');
    // @ts-expect-error — Vite-only absolute module specifier
    const { runAnalysis } = await import('/src/state/analysisActions.ts');
    // @ts-expect-error — Vite-only absolute module specifier
    const { runDirection } = await import('/src/state/directionActions.ts');
    // @ts-expect-error — Vite-only absolute module specifier
    const { StockfishAnalysisEngine } = await import('/src/analysis/StockfishAnalysisEngine.ts');

    const store = new Store(createInitialState());
    loadPgn(store, pgn, new ChessJsEngine());
    const ae = new StockfishAnalysisEngine();
    await runAnalysis(store, ae, new ChessJsEngine());
    ae.dispose();
    const de = new StockfishAnalysisEngine();
    await runDirection(store, de, new ChessJsEngine());
    de.dispose();

    const state = store.getState();
    const scene = state.game!.timeline.scenes[0]!;
    const plan = state.direction.result!.cinematicPlan;

    const plyAtMsByPly: Record<number, number> = {};
    for (const beat of scene.beats) {
      if (beat.kind === 'move') plyAtMsByPly[beat.resultingPly] = beat.atMs;
    }

    return {
      trackingDirectives: plan.trackingDirectives,
      keyframes: scene.cameraPlan.keyframes,
      plyAtMsByPly
    };
  }, pgn);
}

test('at least one of the canonical games produces a real Phase 18D tracking directive, traceable to already-verified evidence', async ({ page }) => {
  const results: { name: string; readout: TrackingReadout }[] = [];
  for (const [name, pgn] of [
    ['Evergreen', EVERGREEN],
    ['Stalemate', STALEMATE],
    ["Scholar's Mate", SCHOLARS_MATE]
  ] as const) {
    results.push({ name, readout: await analyzeTracking(page, pgn) });
  }

  const withTracking = results.filter((r) => r.readout.trackingDirectives.length > 0);
  expect(withTracking.length, 'expected at least one canonical game to produce a tracking directive').toBeGreaterThan(0);

  for (const { readout } of withTracking) {
    for (const t of readout.trackingDirectives) {
      expect(['critical', 'consequence']).toContain(t.role);
      expect(['king-safety', 'move']).toContain(t.evidenceRef.kind);
      expect(t.subject.kind).toBe('piece');
      expect(typeof t.subject.pieceId).toBe('string');
      expect(t.toPly).toBeGreaterThanOrEqual(t.fromPly);
    }
  }
});

test('the real camera plan genuinely MOVES across a multi-ply tracked span — not just that keyframes exist', async ({ page }) => {
  // Evergreen ends 21.Qxd7+ Kxd7 22.Bf5+ Ke8 23.Bd7+ Kf8 24.Bxe7# — a real
  // multi-check king hunt, the canonical shape Batch 1's king-safety subject
  // is meant to cover. If a future engine/story change ever makes this
  // fixture's own critical/consequence span collapse to a single ply, this
  // test's own first assertion (a multi-ply directive exists) fails loudly
  // rather than silently passing on a degenerate case.
  const readout = await analyzeTracking(page, EVERGREEN);
  const multiPly = readout.trackingDirectives.find((t) => t.toPly > t.fromPly);
  expect(multiPly, 'expected Evergreen to produce a multi-ply tracking directive (its own real king hunt)').toBeDefined();

  const fromMs = readout.plyAtMsByPly[multiPly!.fromPly];
  const toMs = readout.plyAtMsByPly[multiPly!.toPly];
  expect(fromMs).toBeDefined();
  expect(toMs).toBeDefined();

  // Every real keyframe strictly inside the tracked span's own time window.
  const withinSpan = readout.keyframes.filter((k) => k.atMs >= fromMs! && k.atMs <= toMs!);
  expect(withinSpan.length).toBeGreaterThanOrEqual(2);

  // The real camera center genuinely differs between at least two of them —
  // proof the camera is actually following the subject ply-to-ply, not
  // holding one static box for the whole span.
  const distinctCenters = new Set(withinSpan.map((k) => `${k.centerX.toFixed(3)},${k.centerY.toFixed(3)}`));
  expect(distinctCenters.size, 'expected the real camera center to change across the tracked span').toBeGreaterThan(1);

  // And it stays within Phase 18B's own established bounds — tracking never
  // produces a tighter-than-allowed or wider-than-full-board zoom.
  for (const k of withinSpan) {
    expect(k.zoom).toBeGreaterThanOrEqual(1);
    expect(k.zoom).toBeLessThanOrEqual(2.2); // DEFAULT_DIRECTOR_SETTINGS.maxZoom
  }
});
