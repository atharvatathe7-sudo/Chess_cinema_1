import { expect, test, type Page } from '@playwright/test';

/**
 * Phase 7B — render/coords.ts's computeViewport now clamps the zoomed
 * camera's centerX/centerY so the visible viewport always stays inside the
 * board's own [0, 8] extent (see the Phase 7A investigation for the full
 * derivation). Before this fix, a climax camera centered near an edge or
 * corner left part of the frame unpainted, which composited to a solid
 * black bar once encoded to VP9 (no alpha channel) — independently
 * observed in real exported frames for these same three games during the
 * Phase 6 post-merge audit and confirmed mathematically in Phase 7A:
 *   - Scholar's Mate: ~78px black bar at the TOP (climax squares g8,f6 ->
 *     mean center (6.0, 1.5), centerY below the valid range)
 *   - Stalemate: ~132px black bar at the TOP (climax squares e8,f7 ->
 *     mean center (5.0, 1.0), centerY below the valid range)
 *   - Promotion race: ~132px black bar at the RIGHT (and a masked-by-the-
 *     caption-band overshoot at the bottom) (climax squares g2,h1 -> mean
 *     center (7.0, 7.0), both axes above the valid range)
 *
 * This file re-exports real WebM video for each game and decodes the same
 * kind of frame that previously showed the defect, then asserts the
 * previously-black edge region now reads like real board content instead
 * of solid black. It does not assert anything about caption content,
 * Moment text, camera timing, or zoom amount — those are unrelated to this
 * fix and are already covered by tests/e2e/captions.spec.ts and
 * tests/e2e/moments.spec.ts, both of which this change leaves untouched.
 *
 * Sampling note (Promotion race specifically): the Scholar's Mate and
 * Stalemate tests below sample at their own "Climax" Moment's own seek
 * point (targetTimeMs, near the END of that Moment's window) because that
 * point is independently confirmed still inside the camera's zoom hold for
 * those two games. Promotion race's single climax camera directive is
 * anchored to ply 10 — which is also that game's own final ply — so the
 * camera's "hold" keyframe and the "reset to zoom 1" keyframe land at the
 * same atMs; by the time the Moment's own end-of-window timestamp is
 * reached the camera has already snapped back to zoom 1 (confirmed via a
 * real exported-frame probe: the previously-black right edge was NEVER
 * black there, even pre-fix — sampling it would not have exercised the
 * clamp at all). Promotion race therefore samples a fixed mid-video
 * fraction (0.5 * video.duration) instead, independently confirmed (via a
 * real pre-fix/post-fix frame comparison at this exact fraction, and a
 * stability sweep across fractions 0.3-0.7) to sit inside the camera's
 * zoom-hold window, where the black bar genuinely existed pre-fix.
 *
 * Phase 9 — "Export Video" now renders at a fixed 1080x1920 portrait size
 * (ui/panel.ts's VIDEO_EXPORT_DIMS). The RIGHT edge (used by the Promotion
 * race test) needs no change: computeViewport's xOffset is always exactly 0
 * in portrait orientation (width is always the constraining dimension,
 * regardless of zoom — see render/coords.test.ts's "Phase 9" describe
 * block), so the frame's own right edge already coincides with the board's
 * right edge, same as it did at square dims. The TOP edge (Scholar's
 * Mate/Stalemate) does need one: yOffset is 420px in portrait orientation
 * (not 0), so the frame's literal top 10 rows are now *correctly* deep
 * inside the letterbox band below the top of the board (see
 * render/Renderer.ts's Phase 9 clip) regardless of whether this fix's own
 * clamp is working — sampling row 0 there would prove nothing about the
 * clamp anymore. BOARD_TOP anchors the same 10-row sample to the board's
 * own top pixel edge instead, where the original defect (and this fix)
 * actually live. tests/e2e/portraitExport.spec.ts separately re-verifies
 * this same clamp guarantee, generically, across all 5 canonical games.
 */

test.describe.configure({ timeout: 180_000 });

/** yOffset for the app's real 1080x1920 video-export RenderDims at any zoom — see the Phase 9 module-comment note above and render/coords.test.ts's "xOffset/yOffset are invariant to zoom in portrait dims" case for the derivation. */
const BOARD_TOP = 420;

const SCHOLARS_MATE = '1. e4 e5 2. Bc4 Bc5 3. Qh5 Nf6 4. Qxf7#';
const STALEMATE = '1. e3 a5 2. Qh5 Ra6 3. Qxa5 h5 4. Qxc7 Rah6 5. h4 f6 6. Qxd7+ Kf7 7. Qxb7 Qd3 8. Qxb8 Qh7 9. Qxc8 Kg6 10. Qe6';
const PROMOTION_RACE = '1. a4 h5 2. a5 h4 3. a6 h3 4. axb7 hxg2 5. bxa8=Q gxh1=Q';

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

/** Seeks to a named Moment via the real Moments UI (same mechanism the app itself uses — seekTo(store, target.targetTimeMs)) and returns the real-browser video-element seek time this timestamp corresponds to, derived from the move-indicator's own displayed seconds. */
async function secondsAtMoment(page: Page, momentLabelSubstring: string): Promise<number> {
  const button = page.locator('#moments-list button.moment-btn', { hasText: momentLabelSubstring });
  await button.first().click();
  await page.waitForTimeout(50);
  const text = (await page.locator('#move-indicator').textContent()) ?? '';
  const match = text.match(/([\d.]+)s\s*\/\s*[\d.]+s\s*$/);
  if (!match) throw new Error(`could not parse move-indicator text: "${text}"`);
  await page.click('#restart-btn');
  await page.waitForTimeout(30);
  return Number(match[1]);
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

interface EdgeReadout {
  readonly width: number;
  readonly height: number;
  readonly topRowsAvgLuminance: number;
  readonly rightColsAvgLuminance: number;
}

/** Decodes one real, played-back frame of a real WebM at timeSec (same technique already established in tests/e2e/videoExport.spec.ts and captions.spec.ts) and reads average luminance across 10 rows starting at BOARD_TOP (the board's own top pixel edge — see this file's Phase 9 module-comment note) and the right 10 columns — the two edges affected across these three games. */
async function decodeEdgeLuminance(page: Page, webmBytes: Buffer, timeSec: number): Promise<EdgeReadout> {
  const base64 = webmBytes.toString('base64');
  return page.evaluate(
    async ({ b64, t, topRowStart }) => {
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
        const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);

        function luminance(r: number, g: number, b: number): number {
          return 0.299 * r + 0.587 * g + 0.114 * b;
        }

        let topSum = 0;
        let topCount = 0;
        for (let y = topRowStart; y < topRowStart + 10; y++) {
          for (let x = 0; x < canvas.width; x++) {
            const i = (y * canvas.width + x) * 4;
            topSum += luminance(data[i]!, data[i + 1]!, data[i + 2]!);
            topCount++;
          }
        }

        let rightSum = 0;
        let rightCount = 0;
        for (let x = canvas.width - 10; x < canvas.width; x++) {
          for (let y = 0; y < canvas.height; y++) {
            const i = (y * canvas.width + x) * 4;
            rightSum += luminance(data[i]!, data[i + 1]!, data[i + 2]!);
            rightCount++;
          }
        }

        return {
          width: canvas.width,
          height: canvas.height,
          topRowsAvgLuminance: topSum / topCount,
          rightColsAvgLuminance: rightSum / rightCount
        };
      } finally {
        URL.revokeObjectURL(url);
        video.remove();
      }
    },
    { b64: base64, t: timeSec, topRowStart: BOARD_TOP }
  );
}

/**
 * Same decoding technique as decodeEdgeLuminance, but seeks to
 * fraction * video.duration (resolved after the video's own metadata
 * loads) rather than a caller-supplied absolute time. Used only by the
 * Promotion race test below — see this file's module comment for why a
 * Moment-derived timestamp doesn't work for that specific game.
 */
async function decodeEdgeLuminanceAtFraction(page: Page, webmBytes: Buffer, fraction: number): Promise<EdgeReadout> {
  const base64 = webmBytes.toString('base64');
  return page.evaluate(
    async ({ b64, frac, topRowStart }) => {
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
        const target = Math.min(video.duration - 0.001, Math.max(0, frac * video.duration));
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
        const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);

        function luminance(r: number, g: number, b: number): number {
          return 0.299 * r + 0.587 * g + 0.114 * b;
        }

        let topSum = 0;
        let topCount = 0;
        for (let y = topRowStart; y < topRowStart + 10; y++) {
          for (let x = 0; x < canvas.width; x++) {
            const i = (y * canvas.width + x) * 4;
            topSum += luminance(data[i]!, data[i + 1]!, data[i + 2]!);
            topCount++;
          }
        }

        let rightSum = 0;
        let rightCount = 0;
        for (let x = canvas.width - 10; x < canvas.width; x++) {
          for (let y = 0; y < canvas.height; y++) {
            const i = (y * canvas.width + x) * 4;
            rightSum += luminance(data[i]!, data[i + 1]!, data[i + 2]!);
            rightCount++;
          }
        }

        return {
          width: canvas.width,
          height: canvas.height,
          topRowsAvgLuminance: topSum / topCount,
          rightColsAvgLuminance: rightSum / rightCount
        };
      } finally {
        URL.revokeObjectURL(url);
        video.remove();
      }
    },
    { b64: base64, frac: fraction, topRowStart: BOARD_TOP }
  );
}

// A solid black, unpainted region reads at (or extremely close to) 0
// luminance. Any real board/piece content — even the darkest square color
// (#4a7a3c, luminance ≈100) under the darkest realistic compositing — reads
// far above this. 30 is a generous, decisive threshold: real content clears
// it easily, while an unpainted region cannot.
const NOT_BLACK_THRESHOLD = 30;

test("Scholar's Mate: the previously-black top edge is now real board content during the Climax camera zoom", async ({ page }) => {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => pageErrors.push(String(err)));

  await loadAnalyzeDirect(page, SCHOLARS_MATE);
  const climaxSeconds = await secondsAtMoment(page, 'Climax');
  const webmBytes = await exportVideoBytes(page);
  const readout = await decodeEdgeLuminance(page, webmBytes, climaxSeconds);

  expect(readout.width).toBe(1080);
  expect(readout.height).toBe(1920);
  expect(readout.topRowsAvgLuminance, 'the board\'s own top edge (BOARD_TOP) should no longer be a black bar').toBeGreaterThan(NOT_BLACK_THRESHOLD);

  expect(consoleErrors).toEqual([]);
  expect(pageErrors).toEqual([]);
});

test('Stalemate: the previously-black top edge is now real board content during the Climax camera zoom', async ({ page }) => {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => pageErrors.push(String(err)));

  await loadAnalyzeDirect(page, STALEMATE);
  const climaxSeconds = await secondsAtMoment(page, 'Climax');
  const webmBytes = await exportVideoBytes(page);
  const readout = await decodeEdgeLuminance(page, webmBytes, climaxSeconds);

  expect(readout.topRowsAvgLuminance, 'top rows should no longer be a black bar').toBeGreaterThan(NOT_BLACK_THRESHOLD);

  expect(consoleErrors).toEqual([]);
  expect(pageErrors).toEqual([]);
});

test('Promotion race: the previously-black right edge is now real board content during the camera zoom hold (mid-video)', async ({ page }) => {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => pageErrors.push(String(err)));

  await loadAnalyzeDirect(page, PROMOTION_RACE);
  // Ground the test in the real Moment (confirms the game still produces
  // it, same as the other two tests), without using its own targetTimeMs
  // for sampling — see this file's module comment and
  // decodeEdgeLuminanceAtFraction's own doc comment for why.
  await expect(page.locator('#moments-list button.moment-btn', { hasText: 'Pawn Journey' }).first()).toBeVisible();

  const webmBytes = await exportVideoBytes(page);
  // 0.5 * video.duration — independently confirmed (real pre-fix/post-fix
  // frame comparison, and a stability sweep across 0.3-0.7) to sit inside
  // the camera's zoom-hold window for this game.
  const MID_VIDEO_FRACTION = 0.5;
  const readout = await decodeEdgeLuminanceAtFraction(page, webmBytes, MID_VIDEO_FRACTION);

  expect(readout.rightColsAvgLuminance, 'right columns should no longer be a black bar').toBeGreaterThan(NOT_BLACK_THRESHOLD);

  expect(consoleErrors).toEqual([]);
  expect(pageErrors).toEqual([]);
});
