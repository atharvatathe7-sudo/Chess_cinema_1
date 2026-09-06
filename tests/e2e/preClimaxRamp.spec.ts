import { expect, test, type Page } from '@playwright/test';

/**
 * Phase 12B — the pre-climax camera zoom previously started easing toward
 * the climax framing from t=0 across the ENTIRE pre-climax portion of the
 * video, so easeOutCubic's own front-loaded shape (render/resolveCamera.ts,
 * unchanged) meant the camera sat near-fully zoomed in — visually static —
 * for a long stretch before the climax actually happened. buildCameraPlan
 * inserts one extra "hold at zoom=1" keyframe at
 * criticalAtMs - preClimaxRampMs whenever the gap since the previous
 * keyframe is longer than that, compressing the eased ramp into a short,
 * fixed window immediately before the 'critical' CameraDirective.
 *
 * Phase 18B — the camera is no longer one fixed climaxZoom region: it is a
 * per-beat, geometry-derived VisualRegion (director/camera.ts), and Phase
 * 18A's clip windowing means a game's own selected clip — not the whole
 * game — is what gets exported. So this file no longer pins exact
 * climaxAtMs/zoom constants (those are a function of the selected story's
 * own geometry and window, not a fixed product decision); instead it reads
 * the real, live CinematicPlan.cameraDirectives to find the 'critical'
 * directive and its own real timing, then verifies the RAMP PROPERTY
 * against that — real exported WebM pixels, and real resolveCamera output,
 * exactly as before.
 */

test.describe.configure({ timeout: 180_000 });

const SCHOLARS_MATE = '1. e4 e5 2. Bc4 Bc5 3. Qh5 Nf6 4. Qxf7#';
const EVERGREEN =
  '1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. b4 Bxb4 5. c3 Ba5 6. d4 exd4 7. O-O d3 8. Qb3 Qf6 9. e5 Qg6 10. Re1 Nge7 11. Ba3 b5 12. Qxb5 Rb8 13. Qa4 Bb6 14. Nbd2 Bb7 15. Ne4 Qf5 16. Bxd3 Qh5 17. Nf6+ gxf6 18. exf6 Rg8 19. Rad1 Qxf3 20. Rxe7+ Nxe7 21. Qxd7+ Kxd7 22. Bf5+ Ke8 23. Bd7+ Kf8 24. Bxe7#';
const STALEMATE = '1. e3 a5 2. Qh5 Ra6 3. Qxa5 h5 4. Qxc7 Rah6 5. h4 f6 6. Qxd7+ Kf7 7. Qxb7 Qd3 8. Qxb8 Qh7 9. Qxc8 Kg6 10. Qe6';
const PROMOTION_RACE = '1. a4 h5 2. a5 h4 3. a6 h3 4. axb7 hxg2 5. bxa8=Q gxh1=Q';
const QUIET = '1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7';

const PRE_CLIMAX_RAMP_MS = 1200;
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
  /** The real 'critical' CameraDirective's own zoom, or null when the story has no climax beat. */
  readonly criticalZoom: number | null;
  readonly criticalAtMs: number | null;
  /** Whatever keyframe already exists right before the critical directive's own ramp/zoom-in — the ramp's real baseline, not always 0. */
  readonly priorKeyframeAtMs: number | null;
  readonly rampStartMs: number | null;
  readonly camAtFreeze: { centerX: number; centerY: number; zoom: number };
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

/** Decodes one real frame of a real WebM at timeSec via a real <video> element, and returns a row-luminance profile of the board region (used to compare framing/content between two frames) plus edge/board sanity readings — same technique this project's own hook.spec.ts/terminalHold.spec.ts already use. */
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

/** Live pipeline query — the real CinematicPlan.cameraDirectives, the real lowered CameraPlan, and resolveCamera at the Phase 12A freeze time. */
async function analyzeCameraPlan(page: Page, pgn: string): Promise<CameraPlanReadout> {
  await loadAnalyzeDirect(page, pgn);
  return page.evaluate(async (pgn) => {
    // Vite dev-server absolute module specifiers, resolved in-browser at
    // runtime — not resolvable by tsc, which only ever sees this file's
    // Node/Playwright side. Same technique this project's own investigation
    // scripts already use to query the real live pipeline.
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

    const critical = plan.cameraDirectives.find((d: { role: string }) => d.role === 'critical') ?? null;
    const criticalBeat = critical ? scene.beats.find((b: { kind: string; resultingPly: number }) => b.kind === 'move' && b.resultingPly === critical.atPly) : null;
    const criticalAtMs = criticalBeat ? criticalBeat.atMs : null;
    const priorKeyframeAtMs =
      criticalAtMs !== null
        ? Math.max(0, ...cameraPlan.keyframes.filter((k: { atMs: number }) => k.atMs < criticalAtMs).map((k: { atMs: number }) => k.atMs))
        : null;
    const rampStartMs =
      criticalAtMs !== null && priorKeyframeAtMs !== null ? Math.max(priorKeyframeAtMs, criticalAtMs - DEFAULT_DIRECTOR_SETTINGS.preClimaxRampMs) : null;

    const camAtFreeze = resolveCamera(cameraPlan, scene.durationMs - 1);

    return {
      sceneDurationMs: scene.durationMs,
      keyframes: cameraPlan.keyframes,
      criticalZoom: critical ? critical.zoom : null,
      criticalAtMs,
      priorKeyframeAtMs,
      rampStartMs,
      camAtFreeze
    };
  }, pgn);
}

test("Scholar's Mate: the ramp property holds against whatever the real, windowed clip's own critical timing turns out to be", async ({ page }) => {
  const cam = await analyzeCameraPlan(page, SCHOLARS_MATE);
  expect(cam.criticalAtMs).not.toBeNull();
  expect(cam.keyframes[0]).toEqual({ atMs: 0, centerX: 4, centerY: 4, zoom: 1 });

  if (cam.rampStartMs! > cam.priorKeyframeAtMs!) {
    expect(cam.keyframes.some((k) => k.atMs === cam.rampStartMs && k.zoom === 1 && k.centerX === 4 && k.centerY === 4)).toBe(true);
  } else {
    // Short-gap case: no separate ramp-start keyframe between the prior
    // keyframe and the critical directive's own zoom-in.
    expect(cam.keyframes.filter((k) => k.zoom === 1 && k.atMs > cam.priorKeyframeAtMs! && k.atMs < cam.criticalAtMs!)).toHaveLength(0);
  }

  // Real decoded frames: board content visible and edges never clamp to black anywhere across the clip.
  const webmBytes = await exportVideoBytes(page);
  const early = await decodeFrame(page, webmBytes, Math.min(0.2, cam.criticalAtMs! / 2000));
  const atCritical = await decodeFrame(page, webmBytes, cam.criticalAtMs! / 1000);
  for (const [label, readout] of [
    ['early', early],
    ['critical', atCritical]
  ] as const) {
    expect(readout.boardRegionAvg, `${label}: board region should show real content`).toBeGreaterThan(NOT_BLACK_THRESHOLD);
    expect(readout.leftEdgeAvg, `${label}: left edge must not be a black bar (Phase 7B clamp)`).toBeGreaterThan(NOT_BLACK_THRESHOLD);
    expect(readout.rightEdgeAvg, `${label}: right edge must not be a black bar (Phase 7B clamp)`).toBeGreaterThan(NOT_BLACK_THRESHOLD);
  }
});

interface LongGapCase {
  readonly name: string;
  readonly pgn: string;
}

const GAMES: readonly LongGapCase[] = [
  { name: 'Evergreen', pgn: EVERGREEN },
  { name: 'Stalemate', pgn: STALEMATE },
  { name: 'Promotion race', pgn: PROMOTION_RACE }
];

for (const game of GAMES) {
  test(`${game.name}: whenever the gap before the critical beat exceeds preClimaxRampMs, exactly one full-board ramp-start keyframe appears ${PRE_CLIMAX_RAMP_MS}ms before it`, async ({
    page
  }) => {
    const cam = await analyzeCameraPlan(page, game.pgn);
    expect(cam.criticalAtMs).not.toBeNull();

    if (cam.rampStartMs! > cam.priorKeyframeAtMs!) {
      const rampKeyframes = cam.keyframes.filter((k) => k.atMs === cam.rampStartMs && k.zoom === 1 && k.centerX === 4 && k.centerY === 4);
      expect(rampKeyframes).toHaveLength(1);

      // Deterministic ground truth (real resolveCamera): the camera sits at
      // zoom=1/center=(4,4) for the entire pre-ramp portion of the gap.
      const [camNearPrior, camJustBeforeRamp] = await sampleCamera(page, cam.keyframes, [cam.priorKeyframeAtMs! + 1, Math.max(1, cam.rampStartMs! - 1)]);
      for (const [label, c] of [
        ['near prior keyframe', camNearPrior],
        ['just before ramp', camJustBeforeRamp]
      ] as const) {
        expect(c!.zoom, `${label}: camera must remain at zoom=1 before the ramp starts`).toBe(1);
        expect(c!.centerX, `${label}: camera must remain centered on the full board before the ramp starts`).toBe(4);
        expect(c!.centerY, `${label}: camera must remain centered on the full board before the ramp starts`).toBe(4);
      }

      const webmBytes = await exportVideoBytes(page);
      const justBeforeRamp = await decodeFrame(page, webmBytes, Math.max(0, (cam.rampStartMs! - 200) / 1000));
      const justBeforeCritical = await decodeFrame(page, webmBytes, Math.max(0, (cam.criticalAtMs! - 100) / 1000));
      expect(
        sumAbsDiff(justBeforeRamp.rowAverages, justBeforeCritical.rowAverages),
        'the board framing should visibly change between just-before-the-ramp and just-before-the-critical-beat — the zoom happens inside this window'
      ).toBeGreaterThan(5);

      for (const [label, readout] of [
        ['justBeforeRamp', justBeforeRamp],
        ['justBeforeCritical', justBeforeCritical]
      ] as const) {
        expect(readout.boardRegionAvg, `${label}: board region should show real content`).toBeGreaterThan(NOT_BLACK_THRESHOLD);
        expect(readout.leftEdgeAvg, `${label}: left edge must not be a black bar (Phase 7B clamp)`).toBeGreaterThan(NOT_BLACK_THRESHOLD);
        expect(readout.rightEdgeAvg, `${label}: right edge must not be a black bar (Phase 7B clamp)`).toBeGreaterThan(NOT_BLACK_THRESHOLD);
      }
    } else {
      // Short-gap case for this particular windowed clip: no ramp keyframe expected.
      expect(cam.keyframes.filter((k) => k.zoom === 1 && k.atMs > cam.priorKeyframeAtMs! && k.atMs < cam.criticalAtMs!)).toHaveLength(0);
    }

    // Phase 12A cross-regression: the terminal-hold freeze anchor must still
    // land at zoom=1/center=(4,4), unaffected by geometry-driven framing.
    expect(cam.camAtFreeze.zoom, "Phase 12A's freeze-time zoom must remain ~1.0").toBeCloseTo(1, 5);
    expect(cam.camAtFreeze.centerX).toBeCloseTo(4, 5);
    expect(cam.camAtFreeze.centerY).toBeCloseTo(4, 5);
  });
}

test('Quiet: no camera directive exists, and the pre-climax ramp change has no effect', async ({ page }) => {
  const cam = await analyzeCameraPlan(page, QUIET);
  expect(cam.criticalAtMs).toBeNull();
  expect(cam.keyframes).toHaveLength(1);
  expect(cam.keyframes[0]).toEqual({ atMs: 0, centerX: 4, centerY: 4, zoom: 1 });

  const webmBytes = await exportVideoBytes(page);
  const readout = await decodeFrame(page, webmBytes, 1.0);
  expect(readout.boardRegionAvg).toBeGreaterThan(NOT_BLACK_THRESHOLD);
  expect(readout.leftEdgeAvg).toBeGreaterThan(NOT_BLACK_THRESHOLD);
  expect(readout.rightEdgeAvg).toBeGreaterThan(NOT_BLACK_THRESHOLD);
});

test('Phase 12A cross-regression: the terminal hold still extends the WebM by ~1500ms with a stable, visible caption, for all three terminal games', async ({
  page
}) => {
  for (const { pgn } of [{ pgn: SCHOLARS_MATE }, { pgn: EVERGREEN }, { pgn: STALEMATE }]) {
    await loadAnalyzeDirect(page, pgn);
    const sceneSeconds = Number(
      ((await page.locator('#move-indicator').textContent()) ?? '').match(/\/\s*([\d.]+)s\s*$/)?.[1] ?? '0'
    );
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
    expect(addedMs, 'the Phase 12A terminal hold should still add ~1500ms, unaffected by the pre-climax ramp change').toBeGreaterThan(1100);
    expect(addedMs).toBeLessThan(1900);

    const nearEnd = await decodeFrame(page, webmBytes, duration - 0.1);
    const veryEnd = await decodeFrame(page, webmBytes, duration - 0.02);
    expect(sumAbsDiff(nearEnd.rowAverages, veryEnd.rowAverages), 'the terminal hold frame should remain stable/frozen').toBeLessThan(1);
    expect(nearEnd.leftEdgeAvg, 'no black/clamped edges during the terminal hold').toBeGreaterThan(NOT_BLACK_THRESHOLD);
    expect(nearEnd.rightEdgeAvg, 'no black/clamped edges during the terminal hold').toBeGreaterThan(NOT_BLACK_THRESHOLD);
  }
});
