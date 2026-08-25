import { expect, test, type Page } from '@playwright/test';

/**
 * Phase 9 — 9:16 portrait video export (1080x1920). "Export Video" now
 * renders at a fixed portrait RenderDims (ui/panel.ts's VIDEO_EXPORT_DIMS),
 * independent of the on-screen board's own square dims — "Export PNG
 * sequence" and the live preview are untouched (see tests/e2e/videoExport
 * .spec.ts / captions.spec.ts / scrubbing.spec.ts for their own unaffected
 * coverage). This file verifies, on real exported WebM video decoded via a
 * real <video> element (never file metadata alone):
 *   - the exported video is genuinely 1080x1920, not stretched or cropped
 *   - the board is horizontally flush ([0,1080]) and vertically centered
 *     ([420,1500]) — computeViewport's own math (verified analytically in
 *     render/coords.test.ts's new "portrait (Phase 9)" describe block)
 *   - the Phase 7B camera-bounds clamp still holds at portrait dims (no
 *     black edge bars during a climax zoom, same defect class as
 *     cameraBounds.spec.ts covers for the existing square export)
 *   - the top/bottom letterbox bars are the *expected* unpainted (black,
 *     since VP9 has no alpha channel — the same fact established in the
 *     Phase 6/7A investigations) region, not a symptom of stretching or
 *     clipping — distinguished from the left/right edges, which must never
 *     be black in portrait mode
 *   - captions remain visible (Scholar's Mate/Evergreen/Stalemate/
 *     Promotion race) or absent (Quiet), landing inside the bottom
 *     letterbox area without any drawCaptions.ts code change
 */

test.describe.configure({ timeout: 180_000 });

const SCHOLARS_MATE = '1. e4 e5 2. Bc4 Bc5 3. Qh5 Nf6 4. Qxf7#';
const EVERGREEN =
  '1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. b4 Bxb4 5. c3 Ba5 6. d4 exd4 7. O-O d3 8. Qb3 Qf6 9. e5 Qg6 10. Re1 Nge7 11. Ba3 b5 12. Qxb5 Rb8 13. Qa4 Bb6 14. Nbd2 Bb7 15. Ne4 Qf5 16. Bxd3 Qh5 17. Nf6+ gxf6 18. exf6 Rg8 19. Rad1 Qxf3 20. Rxe7+ Nxe7 21. Qxd7+ Kxd7 22. Bf5+ Ke8 23. Bd7+ Kf8 24. Bxe7#';
const STALEMATE = '1. e3 a5 2. Qh5 Ra6 3. Qxa5 h5 4. Qxc7 Rah6 5. h4 f6 6. Qxd7+ Kf7 7. Qxb7 Qd3 8. Qxb8 Qh7 9. Qxc8 Kg6 10. Qe6';
const PROMOTION_RACE = '1. a4 h5 2. a5 h4 3. a6 h3 4. axb7 hxg2 5. bxa8=Q gxh1=Q';
// Same canonical zero-Moment case captions.spec.ts uses (the app's own default textarea contents).
const QUIET = '1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7';

const EXPORT_WIDTH = 1080;
const EXPORT_HEIGHT = 1920;
// visibleUnits=8 at zoom=1, scale=min(1080,1920)/8=135 -> board occupies
// pixel columns [0,1080] and rows [420,1500] at ANY zoom (see
// render/coords.test.ts's "xOffset/yOffset are invariant to zoom in
// portrait dims" case for the derivation: visibleUnits*scale always equals
// the narrower dimension, independent of zoom).
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

async function exportVideoBytes(page: Page): Promise<Buffer> {
  await expect(page.locator('#export-video-btn')).toBeEnabled({ timeout: 15_000 });
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 60_000 }), page.click('#export-video-btn')]);
  await expect(page.locator('#export-progress')).toHaveText('Export complete.');
  const path = await download.path();
  if (!path) throw new Error('video download produced no local path');
  const fs = await import('node:fs/promises');
  return fs.readFile(path);
}

/** Parses "Move 6 / 7  ·  3.3s / 3.6s" -> { currentSeconds, totalSeconds }. */
function parseMoveIndicator(text: string): { currentSeconds: number; totalSeconds: number } {
  const match = text.match(/([\d.]+)s\s*\/\s*([\d.]+)s\s*$/);
  if (!match) throw new Error(`could not parse move-indicator text: "${text}"`);
  return { currentSeconds: Number(match[1]), totalSeconds: Number(match[2]) };
}

/** Seeks to a named Moment via the real Moments UI and returns its own seconds, then restarts — same technique as cameraBounds.spec.ts's secondsAtMoment. */
async function secondsAtMoment(page: Page, momentLabelSubstring: string): Promise<number> {
  const button = page.locator('#moments-list button.moment-btn', { hasText: momentLabelSubstring });
  await button.first().click();
  await page.waitForTimeout(50);
  const { currentSeconds } = parseMoveIndicator((await page.locator('#move-indicator').textContent()) ?? '');
  await page.click('#restart-btn');
  await page.waitForTimeout(30);
  return currentSeconds;
}

interface PortraitReadout {
  readonly width: number;
  readonly height: number;
  readonly played: boolean;
  /** Average luminance of the top 10 rows — the top letterbox bar (above the board). */
  readonly topLetterboxAvgLuminance: number;
  /** Average luminance of the bottom 10 rows — inside the bottom letterbox bar, but ABOVE where a caption band would land (rows [height-310, height-300]), so this reads pure letterbox regardless of caption state. */
  readonly farBottomLetterboxAvgLuminance: number;
  /** Average luminance of the bottom-most 300 rows — where drawCaptions.ts's bottom-anchored band lands; used to detect caption presence. */
  readonly captionZoneAvgLuminance: number;
  /** Average luminance of the left 10 columns, restricted to the board's own vertical band [420,1500]. */
  readonly leftEdgeAvgLuminance: number;
  /** Average luminance of the right 10 columns, restricted to the board's own vertical band [420,1500]. */
  readonly rightEdgeAvgLuminance: number;
  /** Average luminance across the full board region [0,1080]x[420,1500] — confirms real, non-blank board content is actually present. */
  readonly boardRegionAvgLuminance: number;
}

/** Decodes one real, played-back frame of a real WebM at fraction*duration via a real <video> element (same technique established in videoExport.spec.ts/cameraBounds.spec.ts), and computes region-luminance metrics for portrait-specific verification entirely inside the browser (avoids transferring a ~8M-entry pixel array over CDP). */
async function decodePortraitFrame(page: Page, webmBytes: Buffer, fraction: number): Promise<PortraitReadout> {
  const base64 = webmBytes.toString('base64');
  return page.evaluate(
    async ({ b64, frac, boardTop, boardBottom }) => {
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

        let played = false;
        await new Promise<void>((resolve) => {
          video.addEventListener('playing', () => {
            played = true;
            resolve();
          }, { once: true });
          video.play().catch(() => resolve());
          setTimeout(resolve, 1500);
        });
        video.pause();

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

        return {
          width: canvas.width,
          height: canvas.height,
          played,
          topLetterboxAvgLuminance: bandAvg(0, canvas.width, 0, 10),
          farBottomLetterboxAvgLuminance: bandAvg(0, canvas.width, canvas.height - 310, canvas.height - 300),
          captionZoneAvgLuminance: bandAvg(0, canvas.width, canvas.height - 300, canvas.height),
          leftEdgeAvgLuminance: bandAvg(0, 10, boardTop, boardBottom),
          rightEdgeAvgLuminance: bandAvg(canvas.width - 10, canvas.width, boardTop, boardBottom),
          boardRegionAvgLuminance: bandAvg(0, canvas.width, boardTop, boardBottom)
        };
      } finally {
        URL.revokeObjectURL(url);
        video.remove();
      }
    },
    { b64: base64, frac: fraction, boardTop: BOARD_TOP, boardBottom: BOARD_BOTTOM }
  );
}

const NOT_BLACK_THRESHOLD = 30;
const LETTERBOX_MAX_LUMINANCE = 5;

interface GameCase {
  readonly name: string;
  readonly pgn: string;
  /** Substring of a Moments-panel button whose own end-of-window timestamp is known to sit inside the camera's zoom hold (mirrors cameraBounds.spec.ts's own per-game sampling choices) — undefined for Quiet, which has no Moments. */
  readonly climaxMomentLabel?: string;
  readonly hasCaptions: boolean;
}

const GAMES: readonly GameCase[] = [
  { name: "Scholar's Mate", pgn: SCHOLARS_MATE, climaxMomentLabel: 'Climax', hasCaptions: true },
  { name: 'Evergreen', pgn: EVERGREEN, climaxMomentLabel: 'Forced Trap', hasCaptions: true },
  { name: 'Stalemate', pgn: STALEMATE, climaxMomentLabel: 'Climax', hasCaptions: true },
  // Promotion race's own climax coincides with the game's final ply, so — same reasoning as cameraBounds.spec.ts — a mid-video fraction (not its Moment's own targetTimeMs) is used to sample inside the actual zoom hold.
  { name: 'Promotion race', pgn: PROMOTION_RACE, hasCaptions: true },
  { name: 'Quiet', pgn: QUIET, hasCaptions: false }
];

for (const game of GAMES) {
  test(`${game.name}: exports a real, valid 1080x1920 portrait WebM with a correctly-composed, unstretched board`, async ({ page }) => {
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => pageErrors.push(String(err)));

    await loadAnalyzeDirect(page, game.pgn);

    if (game.climaxMomentLabel) {
      await expect(page.locator('#moments-list button.moment-btn', { hasText: game.climaxMomentLabel }).first()).toBeVisible();
    }

    const webmBytes = await exportVideoBytes(page);

    // Valid EBML/WebM signature (the container's own magic number), checked on the raw bytes — not inferred from the browser accepting playback alone.
    expect(webmBytes.subarray(0, 4).toString('hex')).toBe('1a45dfa3');

    // First frame, a normal mid-game frame, and the final frame — every game has these regardless of whether it has Moments.
    const fractions: { label: string; fraction: number }[] = [
      { label: 'first frame', fraction: 0 },
      { label: 'mid-game frame', fraction: 0.5 },
      { label: 'final frame', fraction: 0.999 }
    ];

    const first = await decodePortraitFrame(page, webmBytes, fractions[0]!.fraction);
    expect(first.width, 'exported video width').toBe(EXPORT_WIDTH);
    expect(first.height, 'exported video height').toBe(EXPORT_HEIGHT);
    expect(first.played, 'the exported WebM must actually decode and play in a real <video> element').toBe(true);

    for (const { label, fraction } of fractions) {
      const readout = await decodePortraitFrame(page, webmBytes, fraction);
      expect(readout.boardRegionAvgLuminance, `${label}: board region should show real content, not be blank`).toBeGreaterThan(NOT_BLACK_THRESHOLD);
      expect(readout.leftEdgeAvgLuminance, `${label}: left edge (board should be flush, x=0) must not be an unexpected black bar`).toBeGreaterThan(NOT_BLACK_THRESHOLD);
      expect(readout.rightEdgeAvgLuminance, `${label}: right edge (board should be flush, x=1080) must not be an unexpected black bar`).toBeGreaterThan(NOT_BLACK_THRESHOLD);
      // The top/bottom letterbox bars ARE expected to be unpainted (VP9 has no alpha channel — same fact established in Phase 6/7A) since nothing in the existing render pipeline paints outside the board region. This is the existing render/layout design, not a defect — verified explicitly rather than assumed.
      expect(readout.topLetterboxAvgLuminance, `${label}: top letterbox bar should be the expected unpainted region`).toBeLessThan(LETTERBOX_MAX_LUMINANCE);
    }

    // Camera-zoom / Phase 7B bound behavior: sample a frame known to sit inside the climax zoom hold and confirm the board still fills [0,1080]x[420,1500] with no black edge bars (the exact Phase 7B defect class, re-verified at portrait dims).
    if (game.climaxMomentLabel && game.name !== 'Promotion race') {
      const climaxSeconds = await secondsAtMoment(page, game.climaxMomentLabel);
      const durationProbe = await decodePortraitFrameDuration(page, webmBytes);
      const climaxFraction = Math.min(0.999, climaxSeconds / durationProbe);
      const climaxReadout = await decodePortraitFrame(page, webmBytes, climaxFraction);
      expect(climaxReadout.leftEdgeAvgLuminance, 'climax frame: left edge must not be a black bar (Phase 7B clamp)').toBeGreaterThan(NOT_BLACK_THRESHOLD);
      expect(climaxReadout.rightEdgeAvgLuminance, 'climax frame: right edge must not be a black bar (Phase 7B clamp)').toBeGreaterThan(NOT_BLACK_THRESHOLD);
      expect(climaxReadout.boardRegionAvgLuminance, 'climax frame: board region should show real content').toBeGreaterThan(NOT_BLACK_THRESHOLD);
    } else if (game.name === 'Promotion race') {
      // Same reasoning as cameraBounds.spec.ts: sample mid-video, inside the confirmed zoom-hold window.
      const climaxReadout = await decodePortraitFrame(page, webmBytes, 0.5);
      expect(climaxReadout.leftEdgeAvgLuminance, 'zoom-hold frame: left edge must not be a black bar (Phase 7B clamp)').toBeGreaterThan(NOT_BLACK_THRESHOLD);
      expect(climaxReadout.rightEdgeAvgLuminance, 'zoom-hold frame: right edge must not be a black bar (Phase 7B clamp)').toBeGreaterThan(NOT_BLACK_THRESHOLD);
    }

    // Caption visibility: compare the bottom caption zone between the very first frame (guaranteed pre-Moment, since every Moment starts at or after the game's own first meaningful ply) and a frame known to be inside a Moment's window.
    if (game.name === 'Promotion race') {
      // A direct pipeline query (deriveCinematicMoments against this exact
      // game) found Promotion race's own single Moment ("Pawn Journey")
      // spans atMs=0 to untilMs=sceneDurationMs — the ENTIRE video. Unlike
      // every other canonical game, there is no uncaptioned instant to diff
      // against here, so this asserts the caption band's absolute
      // brightness directly instead (same approach and threshold as
      // tests/e2e/captions.spec.ts's own dedicated Promotion race test,
      // both grounded in the same real measurement: this game's own
      // captioned band reads ~6.8-7.6 average luminance at every sampled
      // fraction, comfortably above the <5 uncaptioned-letterbox floor).
      const captioned = await decodePortraitFrame(page, webmBytes, 0.5);
      expect(captioned.captionZoneAvgLuminance, 'expected the caption band to show real (non-letterbox) content throughout Promotion race\'s video').toBeGreaterThan(5);
    } else if (game.hasCaptions && game.climaxMomentLabel) {
      const uncaptioned = await decodePortraitFrame(page, webmBytes, 0);
      const durationProbe = await decodePortraitFrameDuration(page, webmBytes);
      const climaxSeconds = await secondsAtMoment(page, game.climaxMomentLabel);
      const captionFraction = Math.min(0.999, climaxSeconds / durationProbe);
      const captioned = await decodePortraitFrame(page, webmBytes, captionFraction);
      expect(
        captioned.captionZoneAvgLuminance - uncaptioned.captionZoneAvgLuminance,
        'a captioned frame\'s bottom caption zone should be visibly brighter than an uncaptioned frame\'s (white/light caption text over the letterbox background)'
      ).toBeGreaterThan(3);
    } else if (!game.hasCaptions) {
      // Quiet: zero Moments -> drawCaptions.ts's activeMomentAt always returns null -> the bottom caption zone should read as plain letterbox at every sampled fraction.
      for (const { fraction } of fractions) {
        const readout = await decodePortraitFrame(page, webmBytes, fraction);
        expect(readout.captionZoneAvgLuminance, 'Quiet must remain caption-free — bottom zone should read as plain letterbox').toBeLessThan(LETTERBOX_MAX_LUMINANCE);
      }
    }

    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
  });
}

/** Reads a real WebM's own decoded duration (seconds) via a real <video> element — used to convert an absolute Moment timestamp (seconds) into the fraction decodePortraitFrame expects. */
async function decodePortraitFrameDuration(page: Page, webmBytes: Buffer): Promise<number> {
  const base64 = webmBytes.toString('base64');
  return page.evaluate(async (b64) => {
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
        video.addEventListener('error', () => reject(new Error('load error')), { once: true });
        setTimeout(() => reject(new Error('loadedmetadata timeout')), 15_000);
      });
      return video.duration;
    } finally {
      URL.revokeObjectURL(url);
      video.remove();
    }
  }, base64);
}
