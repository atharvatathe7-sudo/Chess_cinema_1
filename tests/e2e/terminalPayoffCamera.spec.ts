import { expect, test, type Page } from '@playwright/test';

/**
 * Phase 13B — the camera's push-in previously always fully reset (or nearly
 * so) before the game's actual checkmate/stalemate-delivering move ever
 * played on screen, because the story-layer climax is deliberately anchored
 * on the turning-point move that makes the outcome inevitable, not the
 * later move that mechanically delivers it. buildCameraPlan's terminal
 * payoff re-engagement handles this: for games that actually end in
 * checkmate/stalemate, the camera either extends its existing hold (when
 * the terminal move begins at or before the hold's own natural end) or
 * briefly re-engages right before the terminal move (when there's a real
 * gap with intervening consequence moves), always leaving a short,
 * guaranteed reset tail before sceneDurationMs so Phase 12A's terminal-hold
 * freeze anchor is provably unaffected.
 *
 * Phase 18B — the camera is no longer a single fixed-zoom climax region: it
 * is a per-beat, geometry-derived VisualRegion, and the terminal
 * re-engagement now applies to whichever CameraDirective is LAST (whatever
 * its role), using that directive's own real zoom. Phase 18A's clip
 * windowing also means the exported clip is the selected story, not the
 * whole game. So this file no longer pins exact legacy atMs/zoom constants;
 * it reads the real, live CinematicPlan/CameraPlan and verifies the
 * RE-ENGAGEMENT PROPERTY against that — real exported WebM pixels, and real
 * resolveCamera output, exactly as before.
 */

test.describe.configure({ timeout: 180_000 });

const SCHOLARS_MATE = '1. e4 e5 2. Bc4 Bc5 3. Qh5 Nf6 4. Qxf7#';
const EVERGREEN =
  '1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. b4 Bxb4 5. c3 Ba5 6. d4 exd4 7. O-O d3 8. Qb3 Qf6 9. e5 Qg6 10. Re1 Nge7 11. Ba3 b5 12. Qxb5 Rb8 13. Qa4 Bb6 14. Nbd2 Bb7 15. Ne4 Qf5 16. Bxd3 Qh5 17. Nf6+ gxf6 18. exf6 Rg8 19. Rad1 Qxf3 20. Rxe7+ Nxe7 21. Qxd7+ Kxd7 22. Bf5+ Ke8 23. Bd7+ Kf8 24. Bxe7#';
const STALEMATE = '1. e3 a5 2. Qh5 Ra6 3. Qxa5 h5 4. Qxc7 Rah6 5. h4 f6 6. Qxd7+ Kf7 7. Qxb7 Qd3 8. Qxb8 Qh7 9. Qxc8 Kg6 10. Qe6';
const PROMOTION_RACE = '1. a4 h5 2. a5 h4 3. a6 h3 4. axb7 hxg2 5. bxa8=Q gxh1=Q';
const QUIET = '1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7';

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
  /** The last CameraDirective's own zoom, or null when the story has no camera directive at all. */
  readonly lastDirectiveZoom: number | null;
  readonly terminalPlyAtMs: number | null;
  readonly camAtFreeze: { centerX: number; centerY: number; zoom: number };
}

/** Live pipeline query — the real CinematicPlan.cameraDirectives, the real lowered CameraPlan, and resolveCamera at the Phase 12A freeze time. */
async function analyzeCameraPlan(page: Page, pgn: string): Promise<CameraPlanReadout> {
  await loadAnalyzeDirect(page, pgn);
  return page.evaluate(async (pgn) => {
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

    const lastDirective = plan.cameraDirectives.length > 0 ? plan.cameraDirectives[plan.cameraDirectives.length - 1] : null;

    // Mirrors lowerToTimeline.ts's own windowReachesGameEnd check: the
    // terminal ply is only meaningful when the WINDOW's own last move is
    // really the game's real last move.
    const gameLastMove = state.game!.gameRecord.moves[state.game!.gameRecord.moves.length - 1];
    const windowedMoveBeats = scene.beats.filter((b: { kind: string }) => b.kind === 'move');
    const windowLastMove = windowedMoveBeats[windowedMoveBeats.length - 1];
    const windowReachesGameEnd = windowLastMove !== undefined && gameLastMove !== undefined && windowLastMove.resultingPly === gameLastMove.ply;
    const terminalPlyAtMs = plan.finalPositionIsTerminal && windowReachesGameEnd ? windowLastMove.atMs : null;

    const camAtFreeze = resolveCamera(cameraPlan, scene.durationMs - 1);

    return {
      sceneDurationMs: scene.durationMs,
      keyframes: cameraPlan.keyframes,
      finalPositionIsTerminal: plan.finalPositionIsTerminal,
      lastDirectiveZoom: lastDirective ? lastDirective.zoom : null,
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

const TERMINAL_GAMES = [
  { name: "Scholar's Mate", pgn: SCHOLARS_MATE },
  { name: 'Evergreen', pgn: EVERGREEN },
  { name: 'Stalemate', pgn: STALEMATE }
];

for (const { name, pgn } of TERMINAL_GAMES) {
  test(`${name}: real terminal games get a terminal payoff re-engagement — the camera is at the last directive's own zoom as the real terminal move begins, and resets to full board by the scene's own end`, async ({
    page
  }) => {
    const cam = await analyzeCameraPlan(page, pgn);
    expect(cam.finalPositionIsTerminal).toBe(true);
    expect(cam.terminalPlyAtMs).not.toBeNull();
    expect(cam.lastDirectiveZoom).not.toBeNull();

    const [atTerminalStart, atTerminalPlus50] = await sampleCamera(page, cam.keyframes, [cam.terminalPlyAtMs!, cam.terminalPlyAtMs! + 50]);
    expect(atTerminalStart!.zoom, 'camera must already be at the payoff directive\'s own zoom as the terminal move begins').toBe(cam.lastDirectiveZoom);
    if (cam.lastDirectiveZoom! > 1) {
      expect(atTerminalPlus50!.zoom, 'camera must remain meaningfully engaged a real portion into the terminal move').toBeGreaterThan(1);
    }

    // Phase 12A freeze anchor: within 1e-6, not the looser toBeCloseTo(x,5).
    expect(Math.abs(cam.camAtFreeze.zoom - 1)).toBeLessThan(1e-6);
    expect(Math.abs(cam.camAtFreeze.centerX - 4)).toBeLessThan(1e-6);
    expect(Math.abs(cam.camAtFreeze.centerY - 4)).toBeLessThan(1e-6);

    // The mandatory reset tail: no keyframe at or after sceneDurationMs - TERMINAL_ZOOM_OUT_MS + 1 stays zoomed.
    const nearEndKeyframes = cam.keyframes.filter((k) => k.atMs >= cam.sceneDurationMs - 1);
    for (const k of nearEndKeyframes) {
      expect(k.zoom).toBe(1);
    }

    const webmBytes = await exportVideoBytes(page);
    const duringTerminal = await decodeFrame(page, webmBytes, (cam.terminalPlyAtMs! + 50) / 1000);
    const nearEnd = await decodeFrame(page, webmBytes, (cam.sceneDurationMs - 100) / 1000);
    for (const [label, readout] of [
      ['duringTerminal', duringTerminal],
      ['nearEnd', nearEnd]
    ] as const) {
      expect(readout.boardRegionAvg, `${label}: board region should show real content`).toBeGreaterThan(NOT_BLACK_THRESHOLD);
      expect(readout.leftEdgeAvg, `${label}: left edge must not be a black bar (Phase 7B clamp)`).toBeGreaterThan(NOT_BLACK_THRESHOLD);
      expect(readout.rightEdgeAvg, `${label}: right edge must not be a black bar (Phase 7B clamp)`).toBeGreaterThan(NOT_BLACK_THRESHOLD);
    }
  });
}

test('Promotion race: no terminal payoff — the game never ends in a genuine terminal result, so no terminal re-engagement ever fires', async ({ page }) => {
  const cam = await analyzeCameraPlan(page, PROMOTION_RACE);
  expect(cam.finalPositionIsTerminal).toBe(false);
  expect(cam.terminalPlyAtMs).toBeNull();
  // The scene always ends back at full-board framing regardless.
  expect(cam.keyframes[cam.keyframes.length - 1]).toEqual({ atMs: cam.sceneDurationMs, centerX: 4, centerY: 4, zoom: 1 });

  const webmBytes = await exportVideoBytes(page);
  const readout = await decodeFrame(page, webmBytes, Math.min(1.0, cam.sceneDurationMs / 2000));
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

test('Phase 12A cross-regression: terminal caption timing, hold duration, and hold stability are all unaffected by geometry-driven camera framing, for all three terminal games', async ({
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
    expect(addedMs, 'the Phase 12A terminal hold should still add ~1500ms, unaffected by geometry-driven camera framing').toBeGreaterThan(1100);
    expect(addedMs).toBeLessThan(1900);

    const nearEnd = await decodeFrame(page, webmBytes, duration - 0.1);
    const veryEnd = await decodeFrame(page, webmBytes, duration - 0.02);
    expect(sumAbsDiff(nearEnd.rowAverages, veryEnd.rowAverages), 'the terminal hold frame should remain stable/frozen — full-board framing, not still zoomed').toBeLessThan(1);
    expect(nearEnd.leftEdgeAvg, 'no black/clamped edges during the terminal hold').toBeGreaterThan(NOT_BLACK_THRESHOLD);
    expect(nearEnd.rightEdgeAvg, 'no black/clamped edges during the terminal hold').toBeGreaterThan(NOT_BLACK_THRESHOLD);
  }
});

