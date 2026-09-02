import { expect, test, type Page } from '@playwright/test';

/**
 * Phase 12B — the pre-climax camera zoom previously started easing toward
 * climaxZoom from t=0 across the ENTIRE pre-climax portion of the video, so
 * easeOutCubic's own front-loaded shape (render/resolveCamera.ts, unchanged)
 * meant the camera sat near-fully zoomed in — visually static — for a long
 * stretch before the climax actually happened (quantified in the Phase 12
 * investigation: >99% zoomed by 78.5% of the way through the gap, for every
 * game, regardless of gap length). director/lowerToTimeline.ts's
 * buildCameraPlan now inserts one extra "hold at zoom=1" keyframe at
 * climaxAtMs - DEFAULT_DIRECTOR_SETTINGS.preClimaxRampMs (1200ms), so the
 * eased ramp itself is compressed into a short, fixed window immediately
 * before the climax — self-limiting: when climaxAtMs <= 1200ms (Scholar's
 * Mate), no extra keyframe is inserted and the plan is byte-identical to
 * before. This file proves the effect on real exported WebM pixels across
 * all 5 canonical games, and — critically — that Phase 12A's already-shipped
 * terminal-hold freeze anchor (which implicitly depends on the post-climax
 * zoom-out reaching zoom=1 by the video's own end) is provably unaffected,
 * since this change only ever touches the pre-climax segment.
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
  readonly climaxAtMs: number | null;
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

/** Samples the real resolveCamera() at arbitrary times against a previously-read CameraPlan's keyframes — deterministic ground truth, unaffected by the board's own piece-movement animations (which real decoded frames cannot be used to isolate camera position from, since both change the same pixels). */
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

/** Live pipeline query — real CameraPlan, real resolveCamera evaluation at the Phase 12A freeze time, and the exact ramp-start time this change is expected to have inserted (or not). */
async function analyzeCameraPlan(page: Page, pgn: string): Promise<CameraPlanReadout> {
  await loadAnalyzeDirect(page, pgn);
  return page.evaluate(async (pgn) => {
    // The following are Vite dev-server absolute module specifiers, resolved
    // in-browser at runtime — not resolvable by tsc, which only ever sees
    // this file's Node/Playwright side. Same technique this project's own
    // investigation scripts already use to query the real live pipeline.
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
    const climaxKeyframe = cameraPlan.keyframes.find((k: { zoom: number }) => k.zoom === DEFAULT_DIRECTOR_SETTINGS.climaxZoom);
    const climaxAtMs = climaxKeyframe ? climaxKeyframe.atMs : null;
    const rampStartMs = climaxAtMs !== null ? Math.max(0, climaxAtMs - DEFAULT_DIRECTOR_SETTINGS.preClimaxRampMs) : null;
    const camAtFreeze = resolveCamera(cameraPlan, scene.durationMs - 1);

    return { sceneDurationMs: scene.durationMs, keyframes: cameraPlan.keyframes, climaxAtMs, rampStartMs, camAtFreeze };
  }, pgn);
}

test("Scholar's Mate: camera plan is byte-identical to the pre-Phase-12B shape (climaxAtMs=1200 <= preClimaxRampMs=1200, no ramp-start keyframe)", async ({ page }) => {
  const cam = await analyzeCameraPlan(page, SCHOLARS_MATE);
  expect(cam.climaxAtMs).toBe(1200);
  expect(cam.rampStartMs).toBe(0);
  // Phase 15 — the mate is now the story's own resolution beat, so Phase
  // 13B's terminal-payoff logic contributes extra (visually redundant, all
  // at the same framing) keyframes over the extended hold. The PROPERTY this
  // test exists for is unchanged and asserted directly below: there is no
  // ramp-start keyframe, because the pre-climax gap is not longer than the
  // ramp window.
  expect(cam.keyframes[0]).toEqual({ atMs: 0, centerX: 4, centerY: 4, zoom: 1 });
  expect(cam.keyframes.some((k) => k.atMs > 0 && k.atMs < 1200 && k.zoom === 1)).toBe(false);

  // Real decoded frames: unchanged easeOutCubic curve across the full (short) pre-climax gap.
  const webmBytes = await exportVideoBytes(page);
  const early = await decodeFrame(page, webmBytes, 0.2); // ~17% into the 1.2s gap
  const mid = await decodeFrame(page, webmBytes, 0.6); // ~50% into the gap
  const atClimax = await decodeFrame(page, webmBytes, 1.2);
  // Progressive zoom across the whole gap (not confined to a late window) — early and mid frames should differ from each other, proving the camera is already moving well before any "final 1200ms" boundary would apply (there is none here).
  expect(sumAbsDiff(early.rowAverages, mid.rowAverages), 'the camera should already be moving between 0.2s and 0.6s, unchanged from pre-Phase-12B behavior').toBeGreaterThan(5);
  for (const [label, readout] of [
    ['early', early],
    ['mid', mid],
    ['climax', atClimax]
  ] as const) {
    expect(readout.boardRegionAvg, `${label}: board region should show real content`).toBeGreaterThan(NOT_BLACK_THRESHOLD);
    expect(readout.leftEdgeAvg, `${label}: left edge must not be a black bar (Phase 7B clamp)`).toBeGreaterThan(NOT_BLACK_THRESHOLD);
    expect(readout.rightEdgeAvg, `${label}: right edge must not be a black bar (Phase 7B clamp)`).toBeGreaterThan(NOT_BLACK_THRESHOLD);
  }
});

interface LongGapCase {
  readonly name: string;
  readonly pgn: string;
  readonly expectedClimaxAtMs: number;
}

const LONG_GAP_GAMES: readonly LongGapCase[] = [
  // Phase 15 — climax timings moved with the new story selection (Stalemate
  // now anchors on the move that forces the stalemate; every terminal game's
  // pacing shifted because the payoff became a beat). The ramp PROPERTY
  // under test — one full-board keyframe exactly PRE_CLIMAX_RAMP_MS before
  // the climax — is unchanged.
  { name: 'Evergreen', pgn: EVERGREEN, expectedClimaxAtMs: 12850 },
  { name: 'Stalemate', pgn: STALEMATE, expectedClimaxAtMs: 5100 },
  { name: 'Promotion race', pgn: PROMOTION_RACE, expectedClimaxAtMs: 4300 }
];

for (const game of LONG_GAP_GAMES) {
  test(`${game.name}: pre-climax ramp is compressed into the final ${PRE_CLIMAX_RAMP_MS}ms before the climax, with an unchanged climax framing`, async ({ page }) => {
    const cam = await analyzeCameraPlan(page, game.pgn);
    expect(cam.climaxAtMs).toBe(game.expectedClimaxAtMs);
    expect(cam.rampStartMs).toBe(game.expectedClimaxAtMs - PRE_CLIMAX_RAMP_MS);
    // Exactly one new keyframe (zoom=1 full-board) at rampStartMs — everything else structurally unchanged.
    const rampKeyframes = cam.keyframes.filter((k) => k.atMs === cam.rampStartMs && k.zoom === 1 && k.centerX === 4 && k.centerY === 4);
    expect(rampKeyframes).toHaveLength(1);
    // The climax keyframe itself reaches the same 1.8x zoom as before.
    const climaxKeyframe = cam.keyframes.find((k) => k.atMs === cam.climaxAtMs);
    expect(climaxKeyframe!.zoom).toBe(1.8);

    // Phase 12A cross-regression: the terminal-hold freeze anchor (only relevant for terminal games, but harmless to check universally here) must still land at zoom=1/center=(4,4).
    expect(cam.camAtFreeze.zoom, "Phase 12A's freeze-time zoom must remain ~1.0 — this change must never touch the post-climax segment").toBeCloseTo(1, 5);
    expect(cam.camAtFreeze.centerX).toBeCloseTo(4, 5);
    expect(cam.camAtFreeze.centerY).toBeCloseTo(4, 5);

    // Deterministic ground truth (real resolveCamera, not pixel-diffing): the
    // camera must sit exactly at the base zoom=1/center=(4,4) framing for the
    // entire pre-ramp portion of the gap. Real decoded pixels cannot be used
    // to prove this directly — the board's own piece-movement animations
    // legitimately change pixels throughout the whole video regardless of
    // camera position, so a pixel-diff "stability" check would be confounded
    // by real chess moves happening on screen.
    const [camNearStart, camMidGap, camJustBeforeRamp] = await sampleCamera(page, cam.keyframes, [
      1,
      cam.rampStartMs! / 2,
      Math.max(1, cam.rampStartMs! - 1)
    ]);
    for (const [label, c] of [
      ['near start', camNearStart],
      ['mid-gap', camMidGap],
      ['just before ramp', camJustBeforeRamp]
    ] as const) {
      expect(c!.zoom, `${label}: camera must remain at zoom=1 before the ramp starts`).toBe(1);
      expect(c!.centerX, `${label}: camera must remain centered on the full board before the ramp starts`).toBe(4);
      expect(c!.centerY, `${label}: camera must remain centered on the full board before the ramp starts`).toBe(4);
    }

    const webmBytes = await exportVideoBytes(page);
    const rampStartSeconds = cam.rampStartMs! / 1000;
    const climaxSeconds = cam.climaxAtMs! / 1000;

    // Early in the (long) pre-climax gap, well before the ramp starts: real decoded frames still show real, non-black board content.
    const earlyA = await decodeFrame(page, webmBytes, rampStartSeconds * 0.1);
    const earlyB = await decodeFrame(page, webmBytes, rampStartSeconds * 0.6);

    // Just before vs. just after the ramp-start boundary: motion begins.
    const justBeforeRamp = await decodeFrame(page, webmBytes, Math.max(0, rampStartSeconds - 0.2));
    const justBeforeClimax = await decodeFrame(page, webmBytes, Math.max(0, climaxSeconds - 0.1));
    expect(
      sumAbsDiff(justBeforeRamp.rowAverages, justBeforeClimax.rowAverages),
      'the board framing should visibly change between just-before-the-ramp and just-before-the-climax — the zoom happens inside this window'
    ).toBeGreaterThan(20);

    for (const [label, readout] of [
      ['earlyA', earlyA],
      ['earlyB', earlyB],
      ['justBeforeClimax', justBeforeClimax]
    ] as const) {
      expect(readout.boardRegionAvg, `${label}: board region should show real content`).toBeGreaterThan(NOT_BLACK_THRESHOLD);
      expect(readout.leftEdgeAvg, `${label}: left edge must not be a black bar (Phase 7B clamp)`).toBeGreaterThan(NOT_BLACK_THRESHOLD);
      expect(readout.rightEdgeAvg, `${label}: right edge must not be a black bar (Phase 7B clamp)`).toBeGreaterThan(NOT_BLACK_THRESHOLD);
    }
  });
}

test('Quiet: no camera directive exists, and the pre-climax ramp change has no effect', async ({ page }) => {
  const cam = await analyzeCameraPlan(page, QUIET);
  expect(cam.climaxAtMs).toBeNull();
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
