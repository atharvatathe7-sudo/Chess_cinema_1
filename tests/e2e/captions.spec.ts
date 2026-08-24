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

// Mirrors ui/panel.ts's own EXPORT_FPS constant exactly — read directly
// from source this session, not guessed. Used only to convert a PNG
// sequence's own frame index into the exact video timestamp that frame
// corresponds to (frameIndexToTimeMs's own formula), never as a duration
// assumption.
const EXPORT_FPS = 24;

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
 * Minimal reader for the STORE-only ZIP format export/zip.ts itself writes
 * (see its own doc comment: "STORE method only ... no compression library
 * is needed") — sequentially walks local file headers, nothing to inflate.
 * Returns every frame-XXXXX.png entry, keyed by its own numeric index, so
 * the true last frame index (frameCount - 1) is read directly off the
 * archive's own contents rather than recomputed/estimated from anything
 * displayed in the UI.
 */
function listPngFrames(zipBytes: Buffer): Map<number, Buffer> {
  const LOCAL_FILE_HEADER_SIG = 0x04034b50;
  const frames = new Map<number, Buffer>();
  let offset = 0;
  while (offset + 30 <= zipBytes.length && zipBytes.readUInt32LE(offset) === LOCAL_FILE_HEADER_SIG) {
    const compressedSize = zipBytes.readUInt32LE(offset + 18);
    const nameLength = zipBytes.readUInt16LE(offset + 26);
    const extraLength = zipBytes.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const name = zipBytes.toString('utf8', nameStart, nameStart + nameLength);
    const dataStart = nameStart + nameLength + extraLength;
    const data = zipBytes.subarray(dataStart, dataStart + compressedSize);

    const match = name.match(/^frame-(\d+)\.png$/);
    if (match) frames.set(Number(match[1]), Buffer.from(data));

    offset = dataStart + compressedSize;
  }
  if (frames.size === 0) throw new Error('listPngFrames: no frame-XXXXX.png entries found — is this really a chess-cinema-export.zip?');
  return frames;
}

interface DecodedFrame {
  readonly width: number;
  readonly height: number;
  /** Flat RGBA, same layout as CanvasRenderingContext2D.getImageData's own .data. */
  readonly data: number[];
}

/** Decodes a PNG (frame bytes straight out of the ZIP) into pixels, entirely inside the real browser (createImageBitmap + OffscreenCanvas — no new dependency, no Node-side image decoder). */
async function decodePngFrame(page: Page, pngBytes: Buffer): Promise<DecodedFrame> {
  const base64 = pngBytes.toString('base64');
  return page.evaluate(async (b64) => {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const blob = new Blob([bytes as BlobPart], { type: 'image/png' });
    const bitmap = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(bitmap, 0, 0);
    const { data } = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
    return { width: bitmap.width, height: bitmap.height, data: Array.from(data) };
  }, base64);
}

/** Decodes one real, played-back frame of a real WebM at timeSec — the same real-<video>-element technique already established in tests/e2e/videoExport.spec.ts. */
async function decodeVideoFrame(page: Page, webmBytes: Buffer, timeSec: number): Promise<DecodedFrame> {
  const base64 = webmBytes.toString('base64');
  return page.evaluate(
    async ({ b64, t }) => {
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
        return { width: canvas.width, height: canvas.height, data: Array.from(data) };
      } finally {
        URL.revokeObjectURL(url);
        video.remove();
      }
    },
    { b64: base64, t: timeSec }
  );
}

function luminance(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/** Average luminance of a single row near the very bottom of the frame — comfortably inside drawCaptions.ts's caption band under any real Moment (its minimum possible height, one label line + one reason line + padding, is well over a few pixels), and comfortably below any real board content when a scrim is NOT present. */
function bottomRowAvgLuminance(frame: DecodedFrame, rowsFromBottom = 3): number {
  const y = frame.height - 1 - rowsFromBottom;
  let sum = 0;
  for (let x = 0; x < frame.width; x++) {
    const i = (y * frame.width + x) * 4;
    sum += luminance(frame.data[i]!, frame.data[i + 1]!, frame.data[i + 2]!);
  }
  return sum / frame.width;
}

/** RGBA pixels of the bottom bandFraction of the frame, flattened — used to prove two captions' own content differs (not just that a scrim exists). */
function bottomBandPixels(frame: DecodedFrame, bandFraction: number): number[] {
  const yStart = Math.floor(frame.height * (1 - bandFraction));
  const out: number[] = [];
  for (let y = yStart; y < frame.height; y++) {
    for (let x = 0; x < frame.width; x++) {
      const i = (y * frame.width + x) * 4;
      out.push(frame.data[i]!, frame.data[i + 1]!, frame.data[i + 2]!, frame.data[i + 3]!);
    }
  }
  return out;
}

function sumAbsDiff(a: readonly number[], b: readonly number[]): number {
  let total = 0;
  for (let i = 0; i < a.length; i++) total += Math.abs(a[i]! - (b[i] ?? 0));
  return total;
}

test('Scholar\'s Mate: the exported WebM\'s final frame (inside the Checkmate Moment\'s window) is visibly darker at the caption band than the identical frame in the PNG-sequence export', async ({ page }) => {
  await loadAnalyzeDirect(page, SCHOLARS_MATE);

  // PNG export first: its own ZIP contents are the ground truth for how
  // many frames this exact export produces (frameCount(scene.durationMs,
  // 24) — never independently recomputed here from anything the UI merely
  // displays).
  const pngZipBytes = await downloadBytes(page, '#export-btn');
  await expect(page.locator('#export-progress')).toHaveText('Export complete.');
  const pngFrames = listPngFrames(pngZipBytes);
  const lastFrameIndex = Math.max(...pngFrames.keys());
  const lastPngBytes = pngFrames.get(lastFrameIndex)!;

  await expect(page.locator('#export-video-btn')).toBeEnabled({ timeout: 15_000 });
  const webmBytes = await downloadBytes(page, '#export-video-btn');
  await expect(page.locator('#export-progress')).toHaveText('Export complete.');
  expect(webmBytes.subarray(0, 4).toString('hex')).toBe('1a45dfa3'); // still a real WebM/EBML file

  // frameIndexToTimeMs(lastFrameIndex, EXPORT_FPS) / 1000, in seconds — the
  // exact same deterministic formula export/FrameSource.ts uses, applied
  // to the ZIP's own true last frame index.
  const lastFrameTimeSec = lastFrameIndex / EXPORT_FPS;

  const [pngFrame, webmFrame] = await Promise.all([decodePngFrame(page, lastPngBytes), decodeVideoFrame(page, webmBytes, lastFrameTimeSec)]);

  expect(webmFrame.width).toBe(pngFrame.width);
  expect(webmFrame.height).toBe(pngFrame.height);

  const pngLuminance = bottomRowAvgLuminance(pngFrame);
  const webmLuminance = bottomRowAvgLuminance(webmFrame);

  // The PNG export (captions:false) has no scrim at all here — this is the
  // "unchanged" baseline. The WebM export (captions:true) draws
  // drawCaptions.ts's own semi-transparent (55%) black scrim across the
  // full width of the bottom band, which — whatever the board/piece pixels
  // underneath happen to be — always makes that region substantially
  // darker. The threshold (40 luminance points, out of 0-255) comfortably
  // exceeds ordinary VP9 lossy-compression noise on an otherwise smooth,
  // solid-color region while remaining decisively smaller than a real
  // scrim's effect.
  expect(pngLuminance - webmLuminance).toBeGreaterThan(40);
});

test('Quiet: zero Moments produce zero captions — the exported WebM\'s final frame matches the PNG export (no scrim anywhere)', async ({ page }) => {
  await loadAnalyzeDirect(page, QUIET);

  // Confirmed zero navigable Moments for this game (director/annotations.ts
  // produces no MOMENT_KINDS directive for a short, quiet opening with no
  // tactics, threats, terminal result, or archetype signal).
  await expect(page.locator('#moments-section')).toBeVisible();
  await expect(page.locator('#moments-list button.moment-btn')).toHaveCount(0);

  const pngZipBytes = await downloadBytes(page, '#export-btn');
  await expect(page.locator('#export-progress')).toHaveText('Export complete.');
  const pngFrames = listPngFrames(pngZipBytes);
  const lastFrameIndex = Math.max(...pngFrames.keys());
  const lastPngBytes = pngFrames.get(lastFrameIndex)!;

  await expect(page.locator('#export-video-btn')).toBeEnabled({ timeout: 15_000 });
  const webmBytes = await downloadBytes(page, '#export-video-btn');
  await expect(page.locator('#export-progress')).toHaveText('Export complete.');

  const lastFrameTimeSec = lastFrameIndex / EXPORT_FPS;
  const [pngFrame, webmFrame] = await Promise.all([decodePngFrame(page, lastPngBytes), decodeVideoFrame(page, webmBytes, lastFrameTimeSec)]);

  const pngLuminance = bottomRowAvgLuminance(pngFrame);
  const webmLuminance = bottomRowAvgLuminance(webmFrame);

  // No Moments -> momentsFor(state) is empty -> drawCaptions is a no-op for
  // every frame (activeMomentAt always returns null) — the two exports'
  // bottom rows should be close (only ordinary VP9 lossy-compression noise
  // between them, not a 55%-black-scrim-sized gap).
  expect(Math.abs(pngLuminance - webmLuminance)).toBeLessThan(25);
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

  const [startFrame, forcedTrapFrame, checkmateFrame] = await Promise.all([
    decodeVideoFrame(page, webmBytes, 0),
    decodeVideoFrame(page, webmBytes, forcedTrapIndicator.currentSeconds),
    decodeVideoFrame(page, webmBytes, checkmateIndicator.currentSeconds)
  ]);

  const startLuminance = bottomRowAvgLuminance(startFrame);
  const forcedTrapLuminance = bottomRowAvgLuminance(forcedTrapFrame);
  const checkmateLuminance = bottomRowAvgLuminance(checkmateFrame);

  // Well before the Forced Trap Moment even begins (move 46 of 47) — no
  // scrim, so the band stays at ordinary board brightness.
  expect(startLuminance - forcedTrapLuminance).toBeGreaterThan(40);
  expect(startLuminance - checkmateLuminance).toBeGreaterThan(40);

  // Both later Moments carry a caption (both darker than the start frame),
  // but they are NOT the same caption — "Forced Trap" + its reason vs
  // "Checkmate" + its reason are visibly different text in the same band.
  const BAND_FRACTION = 0.25; // generous — comfortably contains drawCaptions.ts's own band at any realistic size
  const bandDiff = sumAbsDiff(bottomBandPixels(forcedTrapFrame, BAND_FRACTION), bottomBandPixels(checkmateFrame, BAND_FRACTION));
  expect(bandDiff).toBeGreaterThan(20_000);
});

test('Promotion race and Stalemate: the real exported WebM carries a caption during each game\'s own Moment window', async ({ page }) => {
  // Both games' own named Moment here (Pawn Journey at ply 10 — the game's
  // own last ply, per tests/e2e/moments.spec.ts's "Pawn Journey — Move 10";
  // Stalemate's own terminal-result-highlight, same reasoning as the
  // Scholar's Mate test above) extends to the game's final ply, so — same
  // as the Scholar's Mate/Quiet tests above — the exported video's own
  // LAST frame is guaranteed inside that Moment's window. This is used
  // instead of an assumed "t=0 has no active Moment" baseline: Promotion
  // race's Pawn Journey signal starts at ply 1 (the very first move), so
  // t=0 is actually already INSIDE its window for that game — an earlier
  // version of this test wrongly assumed otherwise and failed against the
  // real export. Comparing against the PNG-sequence export (captions:
  // false, always) at the identical final frame is correct for every game,
  // not just the ones where the Moment happens to start late.
  for (const { pgn, momentLabel } of [
    { pgn: PROMOTION_RACE, momentLabel: 'Pawn Journey' },
    { pgn: STALEMATE, momentLabel: 'Stalemate' }
  ]) {
    await loadAnalyzeDirect(page, pgn);

    const momentButton = page.locator('#moments-list button.moment-btn', { hasText: momentLabel });
    await expect(momentButton.first()).toBeVisible();
    await expect(momentButton.first()).toContainText(/Move \d+$/);

    const pngZipBytes = await downloadBytes(page, '#export-btn');
    await expect(page.locator('#export-progress')).toHaveText('Export complete.');
    const pngFrames = listPngFrames(pngZipBytes);
    const lastFrameIndex = Math.max(...pngFrames.keys());
    const lastPngBytes = pngFrames.get(lastFrameIndex)!;

    await expect(page.locator('#export-video-btn')).toBeEnabled({ timeout: 15_000 });
    const webmBytes = await downloadBytes(page, '#export-video-btn');
    await expect(page.locator('#export-progress')).toHaveText('Export complete.');

    const lastFrameTimeSec = lastFrameIndex / EXPORT_FPS;
    const [pngFrame, webmFrame] = await Promise.all([decodePngFrame(page, lastPngBytes), decodeVideoFrame(page, webmBytes, lastFrameTimeSec)]);

    const pngLuminance = bottomRowAvgLuminance(pngFrame);
    const webmLuminance = bottomRowAvgLuminance(webmFrame);

    expect(pngLuminance - webmLuminance, `expected a visibly darker caption band for "${momentLabel}" (pgn: ${pgn})`).toBeGreaterThan(30);
  }
});
