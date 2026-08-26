import { expect, test, type Page } from '@playwright/test';

/**
 * Phase 13B — the camera's climax zoom-in previously always fully reset
 * (or nearly so) before the game's actual checkmate/stalemate-delivering
 * move ever played on screen, because the story-layer climax is
 * deliberately anchored on the turning-point move that makes the outcome
 * inevitable, not the later move that mechanically delivers it (see the
 * Phase 13 investigation and story.spec.ts's own documented reasoning —
 * that selection is unchanged here). director/lowerToTimeline.ts's
 * buildCameraPlan now adds a terminal payoff re-engagement: for games that
 * actually end in checkmate/stalemate, the camera either extends its
 * existing climax hold (when the terminal move begins at or before the
 * hold's own natural end — Scholar's Mate) or briefly re-engages right
 * before the terminal move (when there's a real gap with intervening
 * consequence moves — Evergreen/Stalemate), always leaving a short,
 * guaranteed reset tail before sceneDurationMs so Phase 12A's terminal-hold
 * freeze anchor (resolveCamera(plan, sceneDurationMs-1) ≈ zoom=1/center=
 * (4,4)) is provably unaffected. This file proves the effect on real
 * exported WebM pixels and live resolveCamera output across all 5
 * canonical games — including that Promotion race and Quiet (neither ends
 * in a genuine terminal result) are completely unaffected.
 */

test.describe.configure({ timeout: 180_000 });

const SCHOLARS_MATE = '1. e4 e5 2. Bc4 Bc5 3. Qh5 Nf6 4. Qxf7#';
const EVERGREEN =
  '1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. b4 Bxb4 5. c3 Ba5 6. d4 exd4 7. O-O d3 8. Qb3 Qf6 9. e5 Qg6 10. Re1 Nge7 11. Ba3 b5 12. Qxb5 Rb8 13. Qa4 Bb6 14. Nbd2 Bb7 15. Ne4 Qf5 16. Bxd3 Qh5 17. Nf6+ gxf6 18. exf6 Rg8 19. Rad1 Qxf3 20. Rxe7+ Nxe7 21. Qxd7+ Kxd7 22. Bf5+ Ke8 23. Bd7+ Kf8 24. Bxe7#';
const STALEMATE = '1. e3 a5 2. Qh5 Ra6 3. Qxa5 h5 4. Qxc7 Rah6 5. h4 f6 6. Qxd7+ Kf7 7. Qxb7 Qd3 8. Qxb8 Qh7 9. Qxc8 Kg6 10. Qe6';
const PROMOTION_RACE = '1. a4 h5 2. a5 h4 3. a6 h3 4. axb7 hxg2 5. bxa8=Q gxh1=Q';
const QUIET = '1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7';

const TERMINAL_ZOOM_OUT_MS = 200;
const TERMINAL_ZOOM_IN_MS = 400;
const NOT_BLACK_THRESHOLD = 30;
const BOARD_TOP = 420;
const BOARD_BOTTOM = 1500;

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

interface CameraPlanReadout {
  readonly sceneDurationMs: number;
  readonly keyframes: readonly { atMs: number; centerX: number; centerY: number; zoom: number }[];
  readonly finalPositionIsTerminal: boolean;
  readonly climaxAtMs: number | null;
  readonly terminalPlyAtMs: number | null;
  readonly camAtFreeze: { centerX: number; centerY: number; zoom: number };
}

/** Live pipeline query — real CinematicPlan.finalPositionIsTerminal, real CameraPlan, and resolveCamera at the Phase 12A freeze time — the deterministic ground truth this file cross-checks real decoded pixels against. */
async function analyzeCameraPlan(page: Page, pgn: string): Promise<CameraPlanReadout> {
  await loadAnalyzeDirect(page, pgn);
  return page.evaluate(async (pgn) => {
    // Vite dev-server absolute module specifiers, resolved in-browser at
    // runtime — not resolvable by tsc, which only ever sees this file's
    // Node/Playwright side. Same technique this project's own
    // investigation scripts and preClimaxRamp.spec.ts already use.
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
    // @ts-expect-error — Vite-only absolute module specifier
    const { resolveCamera } = await import('/src/render/resolveCamera.ts');
    // @ts-expect-error — Vite-only absolute module specifier
    const { DEFAULT_DIRECTOR_SETTINGS } = await import('/src/director/types.ts');

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
    const cameraPlan = scene.cameraPlan;
    const plan = state.direction.result!.cinematicPlan;
    const climaxKeyframe = cameraPlan.keyframes.find((k: { zoom: number }) => k.zoom === DEFAULT_DIRECTOR_SETTINGS.climaxZoom);
    const climaxAtMs = climaxKeyframe ? climaxKeyframe.atMs : null;

    const lastMove = state.game!.gameRecord.moves[state.game!.gameRecord.moves.length - 1];
    const terminalPlyAtMs = plan.finalPositionIsTerminal && lastMove
      ? (scene.beats.find((b: { kind: string; resultingPly: number }) => b.kind === 'move' && b.resultingPly === lastMove.ply)?.atMs ?? null)
      : null;

    const camAtFreeze = resolveCamera(cameraPlan, scene.durationMs - 1);

    return {
      sceneDurationMs: scene.durationMs,
      keyframes: cameraPlan.keyframes,
      finalPositionIsTerminal: plan.finalPositionIsTerminal,
      climaxAtMs,
      terminalPlyAtMs,
      camAtFreeze
    };
  }, pgn);
}

async function exportVideoBytes(page: Page): Promise<Buffer> {
  await expect(page.locator('#export-video-btn')).toBeEnabled({ timeout: 15_000 });
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 60_000 }), page.click('#export-video-btn')]);
  await expect(page.locator('#export-progress')).toHaveText('Export complete.');
  const path = await download.path();
  if (!path) throw new Error('video download produced no local path');
  const fs = await import('node:fs/promises');
  return fs.readFile(path);
}

interface FrameReadout {
  readonly width: number;
  readonly height: number;
  readonly rowAverages: readonly number[];
  readonly leftEdgeAvg: number;
  readonly rightEdgeAvg: number;
  readonly boardRegionAvg: number;
}

/** Decodes one real frame of a real WebM at timeSec via a real <video> element — same technique this project's own hook.spec.ts/terminalHold.spec.ts/preClimaxRamp.spec.ts already use. */
async function decodeFrame(page: Page, webmBytes: Buffer, timeSec: number): Promise<FrameReadout> {
  const base64 = webmBytes.toString('base64');
  return page.evaluate(
    async ({ b64, t, boardTop, boardBottom }) => {
      const binary = atob(b64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const blob = new Blob([bytes as BlobPart], { type: 'video/webm' });
      const url = URL.createObjectURL(blob);
      const video = document.createElement('video');
      video.src = url;
      video.muted = true;
      document.body.appendChild(video);
      try {
        await new Promise<void>((resolve, reject) => {
          video.addEventListener('loadedmetadata', () => resolve(), { once: true });
          video.addEventListener('error', () => reject(new Error(`video load error: ${video.error?.message ?? 'unknown'}`)), { once: true });
          setTimeout(() => reject(new Error('loadedmetadata timeout')), 15_000);
        });
        const target = Math.min(video.duration - 0.001, Math.max(0, t));
        await new Promise<void>((resolve, reject) => {
          const onSeeked = (): void => {
            video.removeEventListener('seeked', onSeeked);
            resolve();
          };
          video.addEventListener('seeked', onSeeked);
          video.currentTime = target;
          setTimeout(() => reject(new Error('seek timeout')), 10_000);
        });

        const canvas = document.createElement('canvas');
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const ctx = canvas.getContext('2d')!;
        ctx.drawImage(video, 0, 0);
        const { data } = ctx.getImageData(0, boardTop, canvas.width, boardBottom - boardTop);

        function luminance(r: number, g: number, b: number): number {
          return 0.299 * r + 0.587 * g + 0.114 * b;
        }
        function bandAvg(x0: number, x1: number, y0: number, y1: number): number {
          let sum = 0;
          let count = 0;
          for (let y = y0; y < y1; y++) {
            for (let x = x0; x < x1; x++) {
              const i = (y * canvas.width + x) * 4;
              sum += luminance(data[i]!, data[i + 1]!, data[i + 2]!);
              count++;
            }
          }
          return count > 0 ? sum / count : 0;
        }

        const rowAverages: number[] = [];
        const boardHeight = boardBottom - boardTop;
        for (let y = 0; y < boardHeight; y += 20) {
          rowAverages.push(bandAvg(0, canvas.width, y, Math.min(y + 20, boardHeight)));
        }

        return {
          width: canvas.width,
          height: canvas.height,
          rowAverages,
          leftEdgeAvg: bandAvg(0, 10, 0, boardHeight),
          rightEdgeAvg: bandAvg(canvas.width - 10, canvas.width, 0, boardHeight),
          boardRegionAvg: bandAvg(0, canvas.width, 0, boardHeight)
        };
      } finally {
        URL.revokeObjectURL(url);
        video.remove();
      }
    },
    { b64: base64, t: timeSec, boardTop: BOARD_TOP, boardBottom: BOARD_BOTTOM }
  );
}

function sumAbsDiff(a: readonly number[], b: readonly number[]): number {
  let total = 0;
  for (let i = 0; i < a.length; i++) total += Math.abs(a[i]! - (b[i] ?? 0));
  return total;
}

/** Samples the real resolveCamera() at arbitrary times against a previously-read CameraPlan's keyframes — deterministic ground truth, unaffected by the board's own piece-movement animations. */
async function sampleCamera(
  page: Page,
  keyframes: CameraPlanReadout['keyframes'],
  atMsList: readonly number[]
): Promise<{ centerX: number; centerY: number; zoom: number }[]> {
  return page.evaluate(
    async ({ keyframes, atMsList }) => {
      // @ts-expect-error — Vite-only absolute module specifier
      const { resolveCamera } = await import('/src/render/resolveCamera.ts');
      return atMsList.map((atMs: number) => resolveCamera({ keyframes }, atMs));
    },
    { keyframes, atMsList }
  );
}

test("Scholar's Mate: zero-gap terminal payoff — the existing climax hold is extended, no separate re-engagement episode", async ({ page }) => {
  const cam = await analyzeCameraPlan(page, SCHOLARS_MATE);
  expect(cam.finalPositionIsTerminal).toBe(true);
  expect(cam.climaxAtMs).toBe(1200);
  expect(cam.terminalPlyAtMs).toBe(3300);
  expect(cam.keyframes).toHaveLength(4);
  expect(cam.keyframes[2]).toEqual({ atMs: 3400, centerX: 6, centerY: 1.5, zoom: 1.8 });

  // Deterministic ground truth: the camera is still at full climax zoom
  // when the actual mate-delivering move (Qxf7#, 3300-3600ms) begins, and
  // stays meaningfully zoomed for a real portion of it — unlike
  // pre-Phase-13B behavior, where zoom was already ~1.1 by the midpoint.
  const [atMoveStart, atMoveMid50] = await sampleCamera(page, cam.keyframes, [3300, 3350]);
  expect(atMoveStart!.zoom).toBe(1.8);
  expect(atMoveMid50!.zoom).toBeGreaterThan(1.5);

  // Phase 12A freeze anchor: within 1e-6, not the looser toBeCloseTo(x,5).
  expect(Math.abs(cam.camAtFreeze.zoom - 1)).toBeLessThan(1e-6);
  expect(Math.abs(cam.camAtFreeze.centerX - 4)).toBeLessThan(1e-6);
  expect(Math.abs(cam.camAtFreeze.centerY - 4)).toBeLessThan(1e-6);

  const webmBytes = await exportVideoBytes(page);
  const duringMove = await decodeFrame(page, webmBytes, 3.35);
  const nearEnd = await decodeFrame(page, webmBytes, (cam.sceneDurationMs - 100) / 1000);
  for (const [label, readout] of [
    ['duringMove', duringMove],
    ['nearEnd', nearEnd]
  ] as const) {
    expect(readout.boardRegionAvg, `${label}: board region should show real content`).toBeGreaterThan(NOT_BLACK_THRESHOLD);
    expect(readout.leftEdgeAvg, `${label}: left edge must not be a black bar (Phase 7B clamp)`).toBeGreaterThan(NOT_BLACK_THRESHOLD);
    expect(readout.rightEdgeAvg, `${label}: right edge must not be a black bar (Phase 7B clamp)`).toBeGreaterThan(NOT_BLACK_THRESHOLD);
  }
});

interface GapCase {
  readonly name: string;
  readonly pgn: string;
  readonly expectedClimaxAtMs: number;
  readonly expectedTerminalPlyAtMs: number;
  readonly expectedClimaxHoldEndMs: number;
  readonly consequenceSampleMs: number;
}

const GAP_CASES: readonly GapCase[] = [
  // consequenceSampleMs is deliberately the exact re-engagement reset
  // keyframe's own atMs (expectedTerminalPlyAtMs - TERMINAL_ZOOM_IN_MS):
  // the down-ramp from the climax hold-end and the up-ramp into the
  // terminal move are smooth, adjacent transitions with no sustained flat
  // hold at zoom=1 in between (see the approved Phase 13A/13B keyframe
  // shape) — this is the one point in time within the whole gap that is
  // mathematically guaranteed to be exactly full-board zoom, and it falls
  // inside a real intervening consequence move's own MoveBeat window in
  // both canonical games (Evergreen's Bd7+, Stalemate's Qxc8).
  { name: 'Evergreen', pgn: EVERGREEN, expectedClimaxAtMs: 12850, expectedTerminalPlyAtMs: 16750, expectedClimaxHoldEndMs: 14950, consequenceSampleMs: 16350 },
  { name: 'Stalemate', pgn: STALEMATE, expectedClimaxAtMs: 5600, expectedTerminalPlyAtMs: 9500, expectedClimaxHoldEndMs: 7700, consequenceSampleMs: 9100 }
];

for (const gc of GAP_CASES) {
  test(`${gc.name}: gap terminal payoff — intervening consequence moves stay full-board, camera re-engages right before the terminal move`, async ({ page }) => {
    const cam = await analyzeCameraPlan(page, gc.pgn);
    expect(cam.finalPositionIsTerminal).toBe(true);
    expect(cam.climaxAtMs).toBe(gc.expectedClimaxAtMs);
    expect(cam.terminalPlyAtMs).toBe(gc.expectedTerminalPlyAtMs);

    // Existing climax hold-end unchanged.
    const holdEndKeyframe = cam.keyframes.find((k) => k.atMs === gc.expectedClimaxHoldEndMs);
    expect(holdEndKeyframe?.zoom).toBe(1.8);

    // New re-engagement keyframes, exact values.
    const reengageResetMs = gc.expectedTerminalPlyAtMs - TERMINAL_ZOOM_IN_MS;
    const reengageReset = cam.keyframes.find((k) => k.atMs === reengageResetMs);
    expect(reengageReset).toBeDefined();
    expect(reengageReset!.zoom).toBe(1);

    const terminalBegin = cam.keyframes.find((k) => k.atMs === gc.expectedTerminalPlyAtMs);
    expect(terminalBegin?.zoom).toBe(1.8);

    const expectedHoldEnd2 = cam.sceneDurationMs - TERMINAL_ZOOM_OUT_MS;
    const holdEnd2 = cam.keyframes.find((k) => k.atMs === expectedHoldEnd2);
    expect(holdEnd2?.zoom).toBe(1.8);

    // Deterministic ground truth: an intervening consequence move (well
    // after the climax hold-end, well before the re-engagement reset)
    // must be at full-board zoom=1 — not left inside an unnaturally
    // extended zoomed hold.
    const [atConsequence, atTerminalStart, atTerminalPlus50] = await sampleCamera(page, cam.keyframes, [
      gc.consequenceSampleMs,
      gc.expectedTerminalPlyAtMs,
      gc.expectedTerminalPlyAtMs + 50
    ]);
    expect(atConsequence!.zoom, 'intervening consequence moves must remain at full-board zoom').toBe(1);
    expect(atTerminalStart!.zoom, 'camera must already be at full climax zoom as the terminal move begins').toBe(1.8);
    expect(atTerminalPlus50!.zoom, 'camera must remain meaningfully zoomed a real portion into the terminal move').toBeGreaterThan(1.5);

    // Phase 12A freeze anchor: within 1e-6.
    expect(Math.abs(cam.camAtFreeze.zoom - 1)).toBeLessThan(1e-6);
    expect(Math.abs(cam.camAtFreeze.centerX - 4)).toBeLessThan(1e-6);
    expect(Math.abs(cam.camAtFreeze.centerY - 4)).toBeLessThan(1e-6);

    const webmBytes = await exportVideoBytes(page);
    const consequenceFrame = await decodeFrame(page, webmBytes, gc.consequenceSampleMs / 1000);
    const duringTerminalMove = await decodeFrame(page, webmBytes, (gc.expectedTerminalPlyAtMs + 50) / 1000);
    for (const [label, readout] of [
      ['consequenceFrame', consequenceFrame],
      ['duringTerminalMove', duringTerminalMove]
    ] as const) {
      expect(readout.boardRegionAvg, `${label}: board region should show real content`).toBeGreaterThan(NOT_BLACK_THRESHOLD);
      expect(readout.leftEdgeAvg, `${label}: left edge must not be a black bar (Phase 7B clamp)`).toBeGreaterThan(NOT_BLACK_THRESHOLD);
      expect(readout.rightEdgeAvg, `${label}: right edge must not be a black bar (Phase 7B clamp)`).toBeGreaterThan(NOT_BLACK_THRESHOLD);
    }
    // The board framing should visibly change between the intervening
    // consequence move (full board) and mid-terminal-move (re-zoomed).
    expect(
      sumAbsDiff(consequenceFrame.rowAverages, duringTerminalMove.rowAverages),
      'framing should visibly differ between the full-board consequence moves and the re-zoomed terminal move'
    ).toBeGreaterThan(10);
  });
}

test('Promotion race: no terminal payoff — remains byte-identical to the pre-Phase-13B camera plan (never terminal)', async ({ page }) => {
  const cam = await analyzeCameraPlan(page, PROMOTION_RACE);
  expect(cam.finalPositionIsTerminal).toBe(false);
  expect(cam.terminalPlyAtMs).toBeNull();
  expect(cam.climaxAtMs).toBe(3100);
  expect(cam.keyframes).toEqual([
    { atMs: 0, centerX: 4, centerY: 4, zoom: 1 },
    { atMs: 1900, centerX: 4, centerY: 4, zoom: 1 },
    { atMs: 3100, centerX: 7, centerY: 6, zoom: 1.8 },
    { atMs: 5200, centerX: 7, centerY: 6, zoom: 1.8 },
    { atMs: 5800, centerX: 4, centerY: 4, zoom: 1 }
  ]);

  const webmBytes = await exportVideoBytes(page);
  const readout = await decodeFrame(page, webmBytes, 4.5);
  expect(readout.boardRegionAvg).toBeGreaterThan(NOT_BLACK_THRESHOLD);
  expect(readout.leftEdgeAvg).toBeGreaterThan(NOT_BLACK_THRESHOLD);
  expect(readout.rightEdgeAvg).toBeGreaterThan(NOT_BLACK_THRESHOLD);
});

test('Quiet: no terminal payoff — remains the single static full-board keyframe (never terminal, no camera directive)', async ({ page }) => {
  const cam = await analyzeCameraPlan(page, QUIET);
  expect(cam.finalPositionIsTerminal).toBe(false);
  expect(cam.terminalPlyAtMs).toBeNull();
  expect(cam.keyframes).toEqual([{ atMs: 0, centerX: 4, centerY: 4, zoom: 1 }]);

  const webmBytes = await exportVideoBytes(page);
  const readout = await decodeFrame(page, webmBytes, 1.0);
  expect(readout.boardRegionAvg).toBeGreaterThan(NOT_BLACK_THRESHOLD);
  expect(readout.leftEdgeAvg).toBeGreaterThan(NOT_BLACK_THRESHOLD);
  expect(readout.rightEdgeAvg).toBeGreaterThan(NOT_BLACK_THRESHOLD);
});

test('Phase 12A cross-regression: terminal caption timing, hold duration, and hold stability are all unaffected by the terminal payoff camera change, for all three terminal games', async ({
  page
}) => {
  for (const { pgn } of [{ pgn: SCHOLARS_MATE }, { pgn: EVERGREEN }, { pgn: STALEMATE }]) {
    await loadAnalyzeDirect(page, pgn);
    const sceneSeconds = Number(((await page.locator('#move-indicator').textContent()) ?? '').match(/\/\s*([\d.]+)s\s*$/)?.[1] ?? '0');
    const webmBytes = await exportVideoBytes(page);
    const duration = await page.evaluate(async (b64) => {
      const binary = atob(b64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const blob = new Blob([bytes as BlobPart], { type: 'video/webm' });
      const url = URL.createObjectURL(blob);
      const video = document.createElement('video');
      video.src = url;
      video.muted = true;
      document.body.appendChild(video);
      await new Promise<void>((res, rej) => {
        video.addEventListener('loadedmetadata', () => res(), { once: true });
        setTimeout(() => rej(new Error('timeout')), 15_000);
      });
      const d = video.duration;
      URL.revokeObjectURL(url);
      video.remove();
      return d;
    }, webmBytes.toString('base64'));

    const addedMs = (duration - sceneSeconds) * 1000;
    expect(addedMs, 'the Phase 12A terminal hold should still add ~1500ms, unaffected by the terminal payoff camera change').toBeGreaterThan(1100);
    expect(addedMs).toBeLessThan(1900);

    const nearEnd = await decodeFrame(page, webmBytes, duration - 0.1);
    const veryEnd = await decodeFrame(page, webmBytes, duration - 0.02);
    expect(sumAbsDiff(nearEnd.rowAverages, veryEnd.rowAverages), 'the terminal hold frame should remain stable/frozen — full-board framing, not still zoomed').toBeLessThan(1);
    expect(nearEnd.leftEdgeAvg, 'no black/clamped edges during the terminal hold').toBeGreaterThan(NOT_BLACK_THRESHOLD);
    expect(nearEnd.rightEdgeAvg, 'no black/clamped edges during the terminal hold').toBeGreaterThan(NOT_BLACK_THRESHOLD);
  }
});
