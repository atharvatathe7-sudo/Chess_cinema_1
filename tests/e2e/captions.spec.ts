import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';

/**
 * Phase 6 — burns the existing deterministic Moment/narrative text
 * (state/moments.ts, already shown in the Moments UI panel) into exported
 * WebM frames only (export/drawCaptions.ts, wired from export/runExport.ts).
 * This file proves it in the real, running app: a real WebM export really
 * contains caption pixels during a Moment's window and not outside one,
 * across several canonical games, and the PNG-sequence export (which never
 * sets runExport's new `captions` option — see ui/panel.ts's handleExport)
 * is provably unaffected. Exact caption TEXT selection (primary-only, never
 * a secondary "Also true" narrative) is unit-tested directly against
 * drawCaptions.ts's pure buildCaptionContent in src/export/drawCaptions.test.ts
 * — this file's job is what only a real browser/real artifact can prove:
 * that the pixels are actually there, actually absent where they should be,
 * and the container is still a normal, playable, duration-unchanged WebM.
 *
 * Phase 9 — "Export Video" now renders at a fixed 1080x1920 portrait size
 * (ui/panel.ts's VIDEO_EXPORT_DIMS), independent of "Export PNG sequence"'s
 * own unchanged square dims (see tests/e2e/portraitExport.spec.ts for full
 * portrait-specific coverage). That retired this file's original
 * PNG-vs-WebM same-pixel-position comparison for caption detection: the two
 * exports no longer share a composition at "the bottom of the frame" (PNG's
 * bottom row is real board content; portrait WebM's bottom rows are deep
 * inside the — now correctly rendered, see render/Renderer.ts's Phase 9
 * clip — letterbox band below the board), so a direct luminance diff
 * between them no longer isolates the caption scrim at all. The caption
 * tests below were updated to compare the WebM against *itself* at an
 * uncaptioned vs. a captioned timestamp instead — decodeCaptionZoneMetrics's
 * wide sampling band (CAPTION_ZONE_BAND_FRACTION), rather than a single row,
 * is also required at portrait dims: drawCaptions.ts's scrim is drawn over the
 * letterbox (already near-black), not over bright board content as at
 * square dims, so the scrim itself adds no contrast — only the caption's
 * own light text glyphs raise the average, and a single fixed row is not
 * reliably guaranteed to intersect any glyph pixel.
 */

test.describe.configure({ timeout: 180_000 });

const SCHOLARS_MATE = '1. e4 e5 2. Bc4 Bc5 3. Qh5 Nf6 4. Qxf7#';
const EVERGREEN =
  '1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. b4 Bxb4 5. c3 Ba5 6. d4 exd4 7. O-O d3 8. Qb3 Qf6 9. e5 Qg6 10. Re1 Nge7 11. Ba3 b5 12. Qxb5 Rb8 13. Qa4 Bb6 14. Nbd2 Bb7 15. Ne4 Qf5 16. Bxd3 Qh5 17. Nf6+ gxf6 18. exf6 Rg8 19. Rad1 Qxf3 20. Rxe7+ Nxe7 21. Qxd7+ Kxd7 22. Bf5+ Ke8 23. Bd7+ Kf8 24. Bxe7#';
const STALEMATE = '1. e3 a5 2. Qh5 Ra6 3. Qxa5 h5 4. Qxc7 Rah6 5. h4 f6 6. Qxd7+ Kf7 7. Qxb7 Qd3 8. Qxb8 Qh7 9. Qxc8 Kg6 10. Qe6';
const PROMOTION_RACE = '1. a4 h5 2. a5 h4 3. a6 h3 4. axb7 hxg2 5. bxa8=Q gxh1=Q';
// The app's own default textarea contents (index.html/ui/panel.ts) — a
// short, quiet opening with no tactics, used throughout this project as
// the canonical zero-Moment case (director/annotations.ts produces no
// MOMENT_KINDS directive for it — no threat refutation, no climax, no
// archetype signal, no terminal result).
const QUIET = '1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7';

/**
 * Phase 9 — fraction of frame height used to detect caption presence/absence
 * (and, via the Evergreen test's own rowAverages-based bandDiff, that two
 * captions' content differs) with decodeCaptionZoneMetrics. Matches
 * tests/e2e/portraitExport.spec.ts's own empirically-verified 300-row band
 * at 1920px height (300/1920 ≈ 0.156, rounded) exactly, rather than the
 * wider 0.25 this file originally used only for the content-differs check.
 * At portrait dims, a
 * caption's scrim contributes no contrast of its own (it's drawn over
 * already-near-black letterbox, not bright board content, unlike at square
 * dims) — only its own light text-glyph pixels do, and diluting that signal
 * across a band 60% wider than the caption itself actually is (drowning it
 * in additional, unrelated, uniformly-black letterbox rows) was empirically
 * unreliable — the original 0.25 caused real intermittent false negatives
 * here, while this exact fraction is independently, repeatedly proven
 * reliable across all 5 canonical games in portraitExport.spec.ts.
 */
const CAPTION_ZONE_BAND_FRACTION = 300 / 1920;

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

/** Parses "Move 46 / 47  ·  16.7s / 17.1s" -> { currentSeconds: 16.7, totalSeconds: 17.1 }. */
function parseMoveIndicator(text: string): { currentSeconds: number; totalSeconds: number } {
  const match = text.match(/([\d.]+)s\s*\/\s*([\d.]+)s\s*$/);
  if (!match) throw new Error(`could not parse move-indicator text: "${text}"`);
  return { currentSeconds: Number(match[1]), totalSeconds: Number(match[2]) };
}

async function downloadBytes(page: Page, clickSelector: string): Promise<Buffer> {
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 60_000 }), page.click(clickSelector)]);
  const path = await download.path();
  if (!path) throw new Error(`download for ${clickSelector} produced no local path`);
  return readFile(path);
}

/**
 * Phase 9 — per-row luminance averages across a bottom band of the frame,
 * plus the band's own overall average. Computed entirely inside the browser
 * (never returning a raw RGBA pixel array to Node) — at 1080x1920 a full
 * getImageData().data array is ~8.3 million numbers, and returning that from
 * page.evaluate three times per test (once per sampled timestamp) caused
 * real page.evaluate timeouts once export resolution grew ~9x over the
 * pre-Phase-9 480x480 export (see the Evergreen test's own note below,
 * where this was first diagnosed). rowAverages (one number per row in the
 * band — a few hundred numbers, not millions) is still enough to detect
 * that two captioned frames' own text content differs (see the Evergreen
 * test), while avgLuminance alone answers every other test's "is a caption
 * present" question.
 */
interface CaptionZoneMetrics {
  readonly width: number;
  readonly height: number;
  readonly avgLuminance: number;
  readonly rowAverages: readonly number[];
}

/** Reads a real WebM's own decoded duration (seconds) via a real <video> element — used to convert a fraction (e.g. Promotion race's mid-video sample point) into an absolute seconds value for decodeCaptionZoneMetrics. */
async function videoDuration(page: Page, webmBytes: Buffer): Promise<number> {
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
        video.addEventListener('error', () => reject(new Error('video load error')), { once: true });
        setTimeout(() => reject(new Error('loadedmetadata timeout')), 15_000);
      });
      return video.duration;
    } finally {
      URL.revokeObjectURL(url);
      video.remove();
    }
  }, base64);
}

/**
 * Decodes one real, played-back frame of a real WebM at timeSec (same
 * real-<video>-element technique already established in
 * tests/e2e/videoExport.spec.ts) and reduces the bottom bandFraction of the
 * frame to per-row luminance averages, entirely inside the browser — see
 * CaptionZoneMetrics's own doc comment for why this never returns a raw
 * pixel array.
 */
async function decodeCaptionZoneMetrics(page: Page, webmBytes: Buffer, timeSec: number, bandFraction: number): Promise<CaptionZoneMetrics> {
  const base64 = webmBytes.toString('base64');
  return page.evaluate(
    async ({ b64, t, bandFraction }) => {
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

        const yStart = Math.floor(canvas.height * (1 - bandFraction));
        const rowAverages: number[] = [];
        let totalSum = 0;
        let totalCount = 0;
        for (let y = yStart; y < canvas.height; y++) {
          let rowSum = 0;
          for (let x = 0; x < canvas.width; x++) {
            const i = (y * canvas.width + x) * 4;
            const l = luminance(data[i]!, data[i + 1]!, data[i + 2]!);
            rowSum += l;
            totalSum += l;
            totalCount++;
          }
          rowAverages.push(rowSum / canvas.width);
        }

        return {
          width: canvas.width,
          height: canvas.height,
          avgLuminance: totalCount > 0 ? totalSum / totalCount : 0,
          rowAverages
        };
      } finally {
        URL.revokeObjectURL(url);
        video.remove();
      }
    },
    { b64: base64, t: timeSec, bandFraction }
  );
}

function sumAbsDiff(a: readonly number[], b: readonly number[]): number {
  let total = 0;
  for (let i = 0; i < a.length; i++) total += Math.abs(a[i]! - (b[i] ?? 0));
  return total;
}

test('Scholar\'s Mate: the exported WebM\'s final frame (inside the Checkmate Moment\'s window) carries a visible caption that the first frame does not', async ({ page }) => {
  await loadAnalyzeDirect(page, SCHOLARS_MATE);

  await expect(page.locator('#export-video-btn')).toBeEnabled({ timeout: 15_000 });
  const webmBytes = await downloadBytes(page, '#export-video-btn');
  await expect(page.locator('#export-progress')).toHaveText('Export complete.');
  expect(webmBytes.subarray(0, 4).toString('hex')).toBe('1a45dfa3'); // still a real WebM/EBML file

  // Sequential, not Promise.all — see the Evergreen test's own Phase 9 note below.
  const startMetrics = await decodeCaptionZoneMetrics(page, webmBytes, 0, CAPTION_ZONE_BAND_FRACTION);
  const finalMetrics = await decodeCaptionZoneMetrics(page, webmBytes, 9999, CAPTION_ZONE_BAND_FRACTION);

  expect(finalMetrics.width).toBe(1080);
  expect(finalMetrics.height).toBe(1920);

  // No Moment is active at t=0 (Checkmate is the game's terminal-result
  // Moment) -> drawCaptions.ts draws nothing there, so the caption band
  // reads as plain (correctly unpainted, see render/Renderer.ts's Phase 9
  // clip) letterbox. The final frame carries the Checkmate caption's label
  // + reason text, whose light glyph pixels measurably raise the band's
  // average even though the scrim itself (drawn over already-near-black
  // letterbox, not bright board content) contributes no contrast of its own.
  expect(finalMetrics.avgLuminance - startMetrics.avgLuminance, 'the captioned final frame should read brighter in the caption band than the uncaptioned first frame').toBeGreaterThan(3);
});

test('Quiet: zero Moments produce zero captions anywhere in the exported WebM', async ({ page }) => {
  await loadAnalyzeDirect(page, QUIET);

  // Confirmed zero navigable Moments for this game (director/annotations.ts
  // produces no MOMENT_KINDS directive for a short, quiet opening with no
  // tactics, threats, terminal result, or archetype signal).
  await expect(page.locator('#moments-section')).toBeVisible();
  await expect(page.locator('#moments-list button.moment-btn')).toHaveCount(0);

  await expect(page.locator('#export-video-btn')).toBeEnabled({ timeout: 15_000 });
  const webmBytes = await downloadBytes(page, '#export-video-btn');
  await expect(page.locator('#export-progress')).toHaveText('Export complete.');

  const startMetrics = await decodeCaptionZoneMetrics(page, webmBytes, 0, CAPTION_ZONE_BAND_FRACTION);
  const finalMetrics = await decodeCaptionZoneMetrics(page, webmBytes, 9999, CAPTION_ZONE_BAND_FRACTION);

  // No Moments -> momentsFor(state) is empty -> drawCaptions is a no-op for
  // every frame (activeMomentAt always returns null) — the caption band
  // should read as plain, unchanging (correctly unpainted, see
  // render/Renderer.ts's Phase 9 clip) letterbox at both ends of the video,
  // with only ordinary VP9 lossy-compression noise between them.
  expect(Math.abs(finalMetrics.avgLuminance - startMetrics.avgLuminance)).toBeLessThan(3);
});

test('Evergreen: caption is absent before any Moment begins, present during the Forced Trap Moment, and visibly different during the later Checkmate Moment', async ({ page }) => {
  await loadAnalyzeDirect(page, EVERGREEN);

  const forcedTrapButton = page.locator('#moments-list button.moment-btn', { hasText: 'Forced Trap' });
  const checkmateButton = page.locator('#moments-list button.moment-btn', { hasText: 'Checkmate' });
  await expect(forcedTrapButton).toHaveCount(1);
  await expect(checkmateButton).toHaveCount(1);

  await forcedTrapButton.click();
  await page.waitForTimeout(30);
  const forcedTrapIndicator = parseMoveIndicator((await page.locator('#move-indicator').textContent()) ?? '');

  await page.click('#restart-btn');
  await page.waitForTimeout(30);
  await checkmateButton.click();
  await page.waitForTimeout(30);
  const checkmateIndicator = parseMoveIndicator((await page.locator('#move-indicator').textContent()) ?? '');

  await page.click('#restart-btn');
  await page.waitForTimeout(30);

  await expect(page.locator('#export-video-btn')).toBeEnabled({ timeout: 15_000 });
  const webmBytes = await downloadBytes(page, '#export-video-btn');
  await expect(page.locator('#export-progress')).toHaveText('Export complete.');

  // Phase 9 — sequential, not Promise.all: three concurrent full-video
  // loads of the same (now much larger — 1080x1920 vs the pre-Phase-9
  // 480x480) WebM caused real resource contention in the browser and
  // pushed this test past its own timeout; decoding one frame at a time
  // (same pattern already established in cameraBounds.spec.ts and
  // portraitExport.spec.ts) avoids it with no loss of coverage. Each
  // decodeCaptionZoneMetrics call also returns only a small rowAverages
  // array (a few hundred numbers), never a raw ~8.3-million-entry RGBA
  // pixel array — see CaptionZoneMetrics's own doc comment; the original
  // (pre-fix) version of this test transferred the latter three times and
  // that alone was enough to independently blow the test timeout even with
  // sequential decoding.
  const startMetrics = await decodeCaptionZoneMetrics(page, webmBytes, 0, CAPTION_ZONE_BAND_FRACTION);
  const forcedTrapMetrics = await decodeCaptionZoneMetrics(page, webmBytes, forcedTrapIndicator.currentSeconds, CAPTION_ZONE_BAND_FRACTION);
  const checkmateMetrics = await decodeCaptionZoneMetrics(page, webmBytes, checkmateIndicator.currentSeconds, CAPTION_ZONE_BAND_FRACTION);

  // Well before the Forced Trap Moment even begins (move 46 of 47) — no
  // caption, so the band reads as plain (correctly unpainted, see
  // render/Renderer.ts's Phase 9 clip) letterbox. The later, captioned
  // frames' light text glyphs measurably raise the band's average (the
  // scrim itself, drawn over already-near-black letterbox rather than
  // bright board content at portrait dims, adds no contrast of its own).
  expect(forcedTrapMetrics.avgLuminance - startMetrics.avgLuminance).toBeGreaterThan(3);
  expect(checkmateMetrics.avgLuminance - startMetrics.avgLuminance).toBeGreaterThan(3);

  // Both later Moments carry a caption (both brighter than the start
  // frame), but they are NOT the same caption — "Forced Trap" + its reason
  // vs "Checkmate" + its reason are visibly different text in the same
  // band. rowAverages (one number per row in the band) is coarser than a
  // full pixel-by-pixel diff, but still resolves genuinely different text
  // layouts/lengths into a real difference.
  const bandDiff = sumAbsDiff(forcedTrapMetrics.rowAverages, checkmateMetrics.rowAverages);
  expect(bandDiff).toBeGreaterThan(20);
});

test('Stalemate: the real exported WebM carries a caption during its own terminal Moment window', async ({ page }) => {
  await loadAnalyzeDirect(page, STALEMATE);

  const momentButton = page.locator('#moments-list button.moment-btn', { hasText: 'Stalemate' });
  await expect(momentButton.first()).toBeVisible();
  await expect(momentButton.first()).toContainText(/Move \d+$/);

  await expect(page.locator('#export-video-btn')).toBeEnabled({ timeout: 15_000 });
  const webmBytes = await downloadBytes(page, '#export-video-btn');
  await expect(page.locator('#export-progress')).toHaveText('Export complete.');

  // Stalemate's own terminal-result-highlight (same reasoning as the
  // Scholar's Mate test above) extends to the game's final ply, so the
  // exported video's own last frame is comfortably inside that window, and
  // t=0 is not.
  const startMetrics = await decodeCaptionZoneMetrics(page, webmBytes, 0, CAPTION_ZONE_BAND_FRACTION);
  const finalMetrics = await decodeCaptionZoneMetrics(page, webmBytes, 9999, CAPTION_ZONE_BAND_FRACTION);

  expect(finalMetrics.avgLuminance - startMetrics.avgLuminance, 'expected a visibly brighter caption band (text over letterbox) for "Stalemate"').toBeGreaterThan(3);
});

test('Promotion race: the real exported WebM carries a caption throughout, matching its own Moment window spanning the whole video', async ({ page }) => {
  await loadAnalyzeDirect(page, PROMOTION_RACE);

  const momentButton = page.locator('#moments-list button.moment-btn', { hasText: 'Pawn Journey' });
  await expect(momentButton.first()).toBeVisible();
  await expect(momentButton.first()).toContainText(/Move \d+$/);

  await expect(page.locator('#export-video-btn')).toBeEnabled({ timeout: 15_000 });
  const webmBytes = await downloadBytes(page, '#export-video-btn');
  await expect(page.locator('#export-progress')).toHaveText('Export complete.');

  // Unlike every other canonical game, Promotion race's own single Moment
  // (a directly-confirmed pipeline query found: archetype-track
  // "Pawn Journey", atMs=0, untilMs=5800 — the game's own full
  // sceneDurationMs) spans the ENTIRE video: there is no uncaptioned
  // instant anywhere to diff against, so — unlike the other caption tests
  // in this file — this asserts the caption band's absolute brightness
  // directly rather than a before/after difference. Real measurement
  // across this exact game's own export (fractions 0-0.999) put the
  // captioned band consistently at ~6.8-7.6 average luminance, comfortably
  // above the near-zero (<3, see the Quiet test's own threshold) noise
  // floor an uncaptioned letterbox band reads at.
  const metrics = await decodeCaptionZoneMetrics(page, webmBytes, 0.5 * (await videoDuration(page, webmBytes)), CAPTION_ZONE_BAND_FRACTION);

  expect(metrics.avgLuminance, 'expected the caption band to show real (non-letterbox) content throughout Promotion race\'s video').toBeGreaterThan(5);
});
