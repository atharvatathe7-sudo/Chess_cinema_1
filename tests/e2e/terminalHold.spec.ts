import { expect, test, type Page } from '@playwright/test';

/**
 * Phase 12A — terminal-result captions (state/moments.ts's own
 * terminal-result-highlight Moment) were previously visible for only the
 * final ply's own MoveBeat duration — as little as ~300ms — because that
 * beat is also the very last thing in the scene. export/runExport.ts now
 * appends a fixed extra TERMINAL_HOLD_MS worth of frames, frozen on the
 * scene's own final frame, whenever the exported game's chronologically
 * last Moment is terminal-result-highlight. This is entirely an
 * export-layer, video-export-only change (gated on the same opts.captions
 * flag PNG export never sets) — no Director/story/timeline file, and no
 * camera math, is touched. This file proves the effect on real exported
 * WebM pixels, and that every game/path this change should NOT touch
 * (Promotion race, Quiet, PNG export, the 480x480 preview, non-terminal
 * caption timing, the Phase 11 hook, and Phase 7B camera-bound framing)
 * is provably unaffected.
 */

test.describe.configure({ timeout: 180_000 });

const SCHOLARS_MATE = '1. e4 e5 2. Bc4 Bc5 3. Qh5 Nf6 4. Qxf7#';
const EVERGREEN =
  '1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. b4 Bxb4 5. c3 Ba5 6. d4 exd4 7. O-O d3 8. Qb3 Qf6 9. e5 Qg6 10. Re1 Nge7 11. Ba3 b5 12. Qxb5 Rb8 13. Qa4 Bb6 14. Nbd2 Bb7 15. Ne4 Qf5 16. Bxd3 Qh5 17. Nf6+ gxf6 18. exf6 Rg8 19. Rad1 Qxf3 20. Rxe7+ Nxe7 21. Qxd7+ Kxd7 22. Bf5+ Ke8 23. Bd7+ Kf8 24. Bxe7#';
const STALEMATE = '1. e3 a5 2. Qh5 Ra6 3. Qxa5 h5 4. Qxc7 Rah6 5. h4 f6 6. Qxd7+ Kf7 7. Qxb7 Qd3 8. Qxb8 Qh7 9. Qxc8 Kg6 10. Qe6';
const PROMOTION_RACE = '1. a4 h5 2. a5 h4 3. a6 h3 4. axb7 hxg2 5. bxa8=Q gxh1=Q';
const QUIET = '1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7';

const EXPORT_WIDTH = 1080;
const EXPORT_HEIGHT = 1920;
const BOARD_TOP = 420;
const BOARD_BOTTOM = 1500;
const NOT_BLACK_THRESHOLD = 30;
const CAPTION_ZONE_BAND_FRACTION = 300 / 1920;

// The exact constant export/runExport.ts uses — restated here independently
// (same convention hook.spec.ts/portraitExport.spec.ts already use for
// their own board-geometry constants) so this file's own expectations are
// a genuine second encoding of "what the design says", not a copy of the
// implementation under test.
const TERMINAL_HOLD_MS = 1500;
const TERMINAL_HOLD_TOLERANCE_MS = 400; // frame-quantization + encoder rounding headroom, same spirit as videoExport.spec.ts's own DURATION_TOLERANCE_SECONDS
const UNCHANGED_DURATION_TOLERANCE_MS = 400;

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

/** Parses "Move 6 / 7  ·  3.3s / 3.6s" -> { currentSeconds, totalSeconds }. totalSeconds reflects scene.durationMs directly (the Timeline's own, never touched by the export-only terminal hold), so it's the correct "before the hold" baseline to diff the real exported video's own decoded duration against. */
function parseMoveIndicator(text: string): { currentSeconds: number; totalSeconds: number } {
  const match = text.match(/([\d.]+)s\s*\/\s*([\d.]+)s\s*$/);
  if (!match) throw new Error(`could not parse move-indicator text: "${text}"`);
  return { currentSeconds: Number(match[1]), totalSeconds: Number(match[2]) };
}

async function sceneTotalSeconds(page: Page): Promise<number> {
  return parseMoveIndicator((await page.locator('#move-indicator').textContent()) ?? '').totalSeconds;
}

/** Seeks to a named Moment via the real Moments UI and returns its own seconds, then restarts — same technique cameraBounds.spec.ts/portraitExport.spec.ts already use. */
async function secondsAtMoment(page: Page, momentLabelSubstring: string): Promise<number> {
  const button = page.locator('#moments-list button.moment-btn', { hasText: momentLabelSubstring });
  await button.first().click();
  await page.waitForTimeout(50);
  const { currentSeconds } = parseMoveIndicator((await page.locator('#move-indicator').textContent()) ?? '');
  await page.click('#restart-btn');
  await page.waitForTimeout(30);
  return currentSeconds;
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

async function exportPngZipBytes(page: Page): Promise<Buffer> {
  await expect(page.locator('#export-btn')).toBeEnabled({ timeout: 15_000 });
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 60_000 }), page.click('#export-btn')]);
  await expect(page.locator('#export-progress')).toHaveText('Export complete.');
  const path = await download.path();
  if (!path) throw new Error('PNG zip download produced no local path');
  const fs = await import('node:fs/promises');
  return fs.readFile(path);
}

function extractFirstZipEntry(zipBytes: Buffer): Buffer {
  const sig = zipBytes.readUInt32LE(0);
  if (sig !== 0x04034b50) throw new Error('extractFirstZipEntry: no local file header at offset 0');
  const compressedSize = zipBytes.readUInt32LE(18);
  const nameLength = zipBytes.readUInt16LE(26);
  const extraLength = zipBytes.readUInt16LE(28);
  const dataStart = 30 + nameLength + extraLength;
  return zipBytes.subarray(dataStart, dataStart + compressedSize);
}

interface FrameReadout {
  readonly width: number;
  readonly height: number;
  readonly captionZoneAvgLuminance: number;
  readonly boardRegionAvgLuminance: number;
  readonly leftEdgeAvgLuminance: number;
  readonly rightEdgeAvgLuminance: number;
  readonly hookZoneAvgLuminance: number;
}

/** Decodes one real frame of a real WebM at timeSec via a real <video> element — same seek-by-time technique captions.spec.ts's decodeCaptionZoneMetrics/hook.spec.ts's decodeHookZone already use. */
async function decodeFrame(page: Page, webmBytes: Buffer, timeSec: number): Promise<FrameReadout> {
  const base64 = webmBytes.toString('base64');
  return page.evaluate(
    async ({ b64, t, bandFraction, boardTop, boardBottom }) => {
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

        const yStart = Math.floor(canvas.height * (1 - bandFraction));
        return {
          width: canvas.width,
          height: canvas.height,
          captionZoneAvgLuminance: bandAvg(0, canvas.width, yStart, canvas.height),
          boardRegionAvgLuminance: bandAvg(0, canvas.width, boardTop, boardBottom),
          leftEdgeAvgLuminance: bandAvg(0, 10, boardTop, boardBottom),
          rightEdgeAvgLuminance: bandAvg(canvas.width - 10, canvas.width, boardTop, boardBottom),
          hookZoneAvgLuminance: bandAvg(0, canvas.width, 150, 260)
        };
      } finally {
        URL.revokeObjectURL(url);
        video.remove();
      }
    },
    { b64: base64, t: timeSec, bandFraction: CAPTION_ZONE_BAND_FRACTION, boardTop: BOARD_TOP, boardBottom: BOARD_BOTTOM }
  );
}

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

interface TerminalGameCase {
  readonly name: string;
  readonly pgn: string;
  readonly hookLabel: string;
}

const TERMINAL_GAMES: readonly TerminalGameCase[] = [
  { name: "Scholar's Mate", pgn: SCHOLARS_MATE, hookLabel: 'CHECKMATE' },
  { name: 'Evergreen', pgn: EVERGREEN, hookLabel: 'FORCED TRAP' },
  { name: 'Stalemate', pgn: STALEMATE, hookLabel: 'STALEMATE' }
];

for (const game of TERMINAL_GAMES) {
  test(`${game.name}: terminal caption dwell is extended by the fixed hold, on a real playable, correctly-framed exported WebM`, async ({ page }) => {
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => pageErrors.push(String(err)));

    await loadAnalyzeDirect(page, game.pgn);
    const sceneSeconds = await sceneTotalSeconds(page);
    const webmBytes = await exportVideoBytes(page);

    // Valid, playable WebM at the correct portrait dims (Phase 9 unaffected).
    expect(webmBytes.subarray(0, 4).toString('hex'), 'EBML signature').toBe('1a45dfa3');
    const duration = await videoDuration(page, webmBytes);
    const first = await decodeFrame(page, webmBytes, 0);
    expect(first.width, 'exported video width').toBe(EXPORT_WIDTH);
    expect(first.height, 'exported video height').toBe(EXPORT_HEIGHT);

    // The added duration is TERMINAL_HOLD_MS, not "however long it takes to squeeze the caption in" — it's real appended seconds on top of the Timeline's own, unmodified scene duration.
    const addedMs = (duration - sceneSeconds) * 1000;
    expect(addedMs, `added duration should be ~${TERMINAL_HOLD_MS}ms on top of the scene's own ${sceneSeconds}s`).toBeGreaterThan(
      TERMINAL_HOLD_MS - TERMINAL_HOLD_TOLERANCE_MS
    );
    expect(addedMs).toBeLessThan(TERMINAL_HOLD_MS + TERMINAL_HOLD_TOLERANCE_MS);

    // The caption stays visible throughout the entire added hold, not just at its start.
    const heldStart = await decodeFrame(page, webmBytes, sceneSeconds + 0.1);
    const heldMid = await decodeFrame(page, webmBytes, sceneSeconds + TERMINAL_HOLD_MS / 2000);
    const heldEnd = await decodeFrame(page, webmBytes, duration - 0.05);
    for (const [label, readout] of [
      ['start of hold', heldStart],
      ['middle of hold', heldMid],
      ['end of hold', heldEnd]
    ] as const) {
      expect(readout.captionZoneAvgLuminance, `${label}: terminal caption should still be visible`).toBeGreaterThan(3);
    }
    // Content is stable (frozen), not flickering or degenerating — the three samples should read the same caption band brightness.
    expect(Math.abs(heldStart.captionZoneAvgLuminance - heldEnd.captionZoneAvgLuminance), 'caption brightness should be stable throughout the hold (frozen frame)').toBeLessThan(1);

    // The intended visual anchor: the same fully-revealed, unstretched board framing the export already settles into at its own natural end — not a black/broken/clamped frame. Left/right edges must not show Phase 7B clamp black bars.
    for (const [label, readout] of [
      ['start of hold', heldStart],
      ['end of hold', heldEnd]
    ] as const) {
      expect(readout.boardRegionAvgLuminance, `${label}: board region should show real, frozen content`).toBeGreaterThan(NOT_BLACK_THRESHOLD);
      expect(readout.leftEdgeAvgLuminance, `${label}: left edge must not be a black bar`).toBeGreaterThan(NOT_BLACK_THRESHOLD);
      expect(readout.rightEdgeAvgLuminance, `${label}: right edge must not be a black bar`).toBeGreaterThan(NOT_BLACK_THRESHOLD);
    }

    // Phase 11 hook: unaffected by a change that only appends frames at the very end — still gone long before the hold even starts.
    expect(heldStart.hookZoneAvgLuminance, 'the Phase 11 opening hook must not reappear during the terminal hold').toBeLessThan(12);

    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
  });
}

test('Scholar\'s Mate: an earlier, non-terminal Moment ("Climax") is completely unaffected by the terminal hold — its own start timing is unchanged', async ({ page }) => {
  await loadAnalyzeDirect(page, SCHOLARS_MATE);
  const webmBytes = await exportVideoBytes(page);

  // Before the Climax Moment starts (atMs=1200 in the real pipeline, i.e. well under 1s): no caption.
  const beforeClimax = await decodeFrame(page, webmBytes, 0.5);
  // Inside the Climax Moment's own window: caption present.
  const duringClimax = await decodeFrame(page, webmBytes, 2.0);

  expect(beforeClimax.captionZoneAvgLuminance, 'before any Moment begins, no caption should be present').toBeLessThan(3);
  expect(duringClimax.captionZoneAvgLuminance, 'during the Climax Moment, a caption should be present').toBeGreaterThan(3);
});

test("Scholar's Mate: the Phase 11 opening hook still appears correctly at t=0 and fades by ~1s, unaffected by the terminal hold appended at the end", async ({ page }) => {
  await loadAnalyzeDirect(page, SCHOLARS_MATE);
  const webmBytes = await exportVideoBytes(page);

  const atStart = await decodeFrame(page, webmBytes, 0);
  const afterFade = await decodeFrame(page, webmBytes, 1.2);

  expect(atStart.hookZoneAvgLuminance, 't=0: the CHECKMATE hook should be visible').toBeGreaterThan(15);
  expect(afterFade.hookZoneAvgLuminance, 't=1.2s: the hook should already be gone, long before the terminal hold at the very end').toBeLessThan(12);
});

test('Scholar\'s Mate and Stalemate: the Phase 7B camera-bound clamp remains intact during the (unmodified) Climax zoom hold', async ({ page }) => {
  for (const { pgn, label } of [
    { pgn: SCHOLARS_MATE, label: 'Climax' },
    { pgn: STALEMATE, label: 'Climax' }
  ]) {
    await loadAnalyzeDirect(page, pgn);
    const climaxSeconds = await secondsAtMoment(page, label);
    const webmBytes = await exportVideoBytes(page);
    const readout = await decodeFrame(page, webmBytes, climaxSeconds);
    expect(readout.leftEdgeAvgLuminance, `${label} zoom hold: left edge must not be a black bar (Phase 7B clamp)`).toBeGreaterThan(NOT_BLACK_THRESHOLD);
    expect(readout.rightEdgeAvgLuminance, `${label} zoom hold: right edge must not be a black bar (Phase 7B clamp)`).toBeGreaterThan(NOT_BLACK_THRESHOLD);
    expect(readout.boardRegionAvgLuminance, `${label} zoom hold: board region should show real content`).toBeGreaterThan(NOT_BLACK_THRESHOLD);
  }
});

test('Promotion race: export duration is unchanged — its own last Moment is archetype-track, never terminal-result-highlight', async ({ page }) => {
  await loadAnalyzeDirect(page, PROMOTION_RACE);
  const sceneSeconds = await sceneTotalSeconds(page);
  const webmBytes = await exportVideoBytes(page);
  const duration = await videoDuration(page, webmBytes);
  expect(Math.abs(duration - sceneSeconds) * 1000, 'no terminal hold should be appended').toBeLessThan(UNCHANGED_DURATION_TOLERANCE_MS);
});

test('Quiet: export duration is unchanged — it has no Moments at all', async ({ page }) => {
  await loadAnalyzeDirect(page, QUIET);
  const sceneSeconds = await sceneTotalSeconds(page);
  const webmBytes = await exportVideoBytes(page);
  const duration = await videoDuration(page, webmBytes);
  expect(Math.abs(duration - sceneSeconds) * 1000, 'no terminal hold should be appended').toBeLessThan(UNCHANGED_DURATION_TOLERANCE_MS);
});

test('Export PNG sequence and the on-screen preview remain 480x480 and unaffected by the terminal hold (video-export-only, gated on the same opts.captions flag PNG export never sets)', async ({
  page
}) => {
  await loadAnalyzeDirect(page, SCHOLARS_MATE);

  const previewDims = await page.evaluate(() => {
    const canvas = document.querySelector('#board') as HTMLCanvasElement;
    return { width: canvas.width, height: canvas.height };
  });
  expect(previewDims.width, 'on-screen preview canvas width').toBe(480);
  expect(previewDims.height, 'on-screen preview canvas height').toBe(480);

  const pngZipBytes = await exportPngZipBytes(page);
  const pngBytes = extractFirstZipEntry(pngZipBytes);
  expect(pngBytes.subarray(0, 8).toString('hex'), 'PNG signature').toBe('89504e470d0a1a0a');

  const pngDims = await page.evaluate(async (base64) => {
    const res = await fetch(`data:image/png;base64,${base64}`);
    const blob = await res.blob();
    const bitmap = await createImageBitmap(blob);
    const dims = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return dims;
  }, pngBytes.toString('base64'));
  expect(pngDims.width, 'PNG export width').toBe(480);
  expect(pngDims.height, 'PNG export height').toBe(480);
});
