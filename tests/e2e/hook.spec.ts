import { expect, test, type Page } from '@playwright/test';

/**
 * Phase 11 — deterministic opening hook (title card) burned into the top
 * portrait letterbox of exported WebM frames only (src/export/drawHook.ts,
 * wired from src/export/runExport.ts, opt-in only from
 * ui/panel.ts's handleExportVideo). Pure selection/opacity logic
 * (selectHook/hookOpacityAt) is already covered deterministically in
 * src/export/drawHook.test.ts (Vitest) — this file's job is what only a
 * real browser can prove: that the correct, SPECIFIC hook text is actually
 * painted into real decoded video pixels (not just "something bright"),
 * that it is confined to the top letterbox with zero bleed into the board,
 * that it follows the appear/hold/fade/gone timeline in a real container,
 * and that every other export/render path (PNG sequence, on-screen
 * preview) is completely unaffected.
 *
 * Evidence technique (per explicit project requirement): NOT bare top-band
 * average luminance. Each candidate hook string (plus a blank/no-text
 * baseline) is independently re-rendered in-browser onto a fresh canvas
 * using the same font stack/size/position the approved design specifies
 * (hardcoded here independently of drawHook.ts's own source, mirroring how
 * portraitExport.spec.ts independently hardcodes BOARD_TOP/BOTTOM rather
 * than importing render code). The real decoded video's hook-region column
 * profile is then compared (sumAbsDiff over bucketed column averages)
 * against all five references, and the CLOSEST match must be the one
 * specific label actually expected for that game — proving the decoded
 * pixels are that game's specific title, not merely bright content that
 * would also satisfy a threshold.
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

// The approved Phase 11 design's own font/position spec, hardcoded here
// independently of drawHook.ts's source (same convention as
// portraitExport.spec.ts's independent BOARD_TOP/BOTTOM derivation) so this
// file's reference renders are a genuine second, independent encoding of
// "what the design says should appear" rather than a copy of the
// implementation under test.
const HOOK_FONT_PX = Math.round(EXPORT_WIDTH * 0.06);
const HOOK_MAX_WIDTH = EXPORT_WIDTH * 0.9;
const HOOK_CENTER_X = EXPORT_WIDTH / 2;
const HOOK_CENTER_Y = BOARD_TOP / 2;
const HOOK_FONT_STACK = 'system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif';

// Row band the hook text is expected to occupy — deliberately tighter than
// the full [0,420) letterbox (real measurement in a prior investigation put
// "CHECKMATE" glyph rows at roughly [180,225]), so background-only rows
// don't dilute the column profile's signal.
const TEXT_BAND_TOP = 150;
const TEXT_BAND_BOTTOM = 260;
// Just above the board — must read as pure background even though it's
// still inside the letterbox, proving zero bleed downward from the text band.
const BOUNDARY_BAND_TOP = 400;
const BOUNDARY_BAND_BOTTOM = 420;
// Just below the board boundary — must show real, non-blank board content.
const BOARD_SAMPLE_TOP = 420;
const BOARD_SAMPLE_BOTTOM = 460;

const COLUMN_BUCKET_WIDTH = 30; // 1080 / 30 = 36 buckets
const HOOK_BACKGROUND_MAX = 12; // background/no-text ceiling (real letterbox measured ~0-1)
const NOT_BLACK_THRESHOLD = 30; // reused convention from portraitExport.spec.ts

const BLANK_LABEL = '__BLANK__';
const CANDIDATE_LABELS = ['CHECKMATE', 'FORCED TRAP', 'STALEMATE', 'PAWN JOURNEY', BLANK_LABEL] as const;

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

async function exportPngZipBytes(page: Page): Promise<Buffer> {
  await expect(page.locator('#export-btn')).toBeEnabled({ timeout: 15_000 });
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 60_000 }), page.click('#export-btn')]);
  await expect(page.locator('#export-progress')).toHaveText('Export complete.');
  const path = await download.path();
  if (!path) throw new Error('PNG zip download produced no local path');
  const fs = await import('node:fs/promises');
  return fs.readFile(path);
}

/** Parses the first (and, for this project's zip.ts STORE-only writer, guaranteed leading) local-file-header entry out of a ZIP archive's raw bytes — no compression to invert, so this is a direct field read, not a decompressor. */
function extractFirstZipEntry(zipBytes: Buffer): Buffer {
  const sig = zipBytes.readUInt32LE(0);
  if (sig !== 0x04034b50) throw new Error('extractFirstZipEntry: no local file header at offset 0');
  const compressedSize = zipBytes.readUInt32LE(18);
  const nameLength = zipBytes.readUInt16LE(26);
  const extraLength = zipBytes.readUInt16LE(28);
  const dataStart = 30 + nameLength + extraLength;
  return zipBytes.subarray(dataStart, dataStart + compressedSize);
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

interface HookZoneMetrics {
  readonly width: number;
  readonly height: number;
  readonly columnAverages: readonly number[];
  readonly boundaryBandAvg: number;
  readonly boardSampleAvg: number;
}

/** Decodes one real frame of a real WebM at timeSec via a real <video> element (same seek-by-time technique as captions.spec.ts's decodeCaptionZoneMetrics), and computes bucketed column-luminance averages over the expected text band plus boundary/board sanity bands — entirely inside the browser, never returning a raw pixel array over CDP. */
async function decodeHookZone(page: Page, webmBytes: Buffer, timeSec: number): Promise<HookZoneMetrics> {
  const base64 = webmBytes.toString('base64');
  return page.evaluate(
    async ({ b64, t, bucketWidth, textTop, textBottom, boundaryTop, boundaryBottom, boardTop, boardBottom }) => {
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

        const columnAverages: number[] = [];
        for (let x = 0; x < canvas.width; x += bucketWidth) {
          columnAverages.push(bandAvg(x, Math.min(x + bucketWidth, canvas.width), textTop, textBottom));
        }

        return {
          width: canvas.width,
          height: canvas.height,
          columnAverages,
          boundaryBandAvg: bandAvg(0, canvas.width, boundaryTop, boundaryBottom),
          boardSampleAvg: bandAvg(0, canvas.width, boardTop, boardBottom)
        };
      } finally {
        URL.revokeObjectURL(url);
        video.remove();
      }
    },
    {
      b64: base64,
      t: timeSec,
      bucketWidth: COLUMN_BUCKET_WIDTH,
      textTop: TEXT_BAND_TOP,
      textBottom: TEXT_BAND_BOTTOM,
      boundaryTop: BOUNDARY_BAND_TOP,
      boundaryBottom: BOUNDARY_BAND_BOTTOM,
      boardTop: BOARD_SAMPLE_TOP,
      boardBottom: BOARD_SAMPLE_BOTTOM
    }
  );
}

/** Independently renders one candidate label (or a blank/no-text baseline) at the approved design's own font/position spec (hardcoded above, not imported from drawHook.ts), and returns the same bucketed column-average profile decodeHookZone produces — so the two are directly comparable. */
async function referenceColumnProfile(page: Page, label: (typeof CANDIDATE_LABELS)[number]): Promise<readonly number[]> {
  return page.evaluate(
    ({ label, blankLabel, width, height, bucketWidth, textTop, textBottom, fontPx, maxWidth, centerX, centerY, fontStack }) => {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = '#000000';
      ctx.fillRect(0, 0, width, height);
      if (label !== blankLabel) {
        ctx.font = `700 ${fontPx}px ${fontStack}`;
        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, centerX, centerY, maxWidth);
      }
      const { data } = ctx.getImageData(0, 0, width, height);

      function luminance(r: number, g: number, b: number): number {
        return 0.299 * r + 0.587 * g + 0.114 * b;
      }

      function bandAvg(x0: number, x1: number, y0: number, y1: number): number {
        let sum = 0;
        let count = 0;
        for (let y = y0; y < y1; y++) {
          for (let x = x0; x < x1; x++) {
            const i = (y * width + x) * 4;
            sum += luminance(data[i]!, data[i + 1]!, data[i + 2]!);
            count++;
          }
        }
        return count > 0 ? sum / count : 0;
      }

      const columnAverages: number[] = [];
      for (let x = 0; x < width; x += bucketWidth) {
        columnAverages.push(bandAvg(x, Math.min(x + bucketWidth, width), textTop, textBottom));
      }
      return columnAverages;
    },
    {
      label,
      blankLabel: BLANK_LABEL,
      width: EXPORT_WIDTH,
      height: BOARD_TOP,
      bucketWidth: COLUMN_BUCKET_WIDTH,
      textTop: TEXT_BAND_TOP,
      textBottom: TEXT_BAND_BOTTOM,
      fontPx: HOOK_FONT_PX,
      maxWidth: HOOK_MAX_WIDTH,
      centerX: HOOK_CENTER_X,
      centerY: HOOK_CENTER_Y,
      fontStack: HOOK_FONT_STACK
    }
  );
}

function sumAbsDiff(a: readonly number[], b: readonly number[]): number {
  let total = 0;
  for (let i = 0; i < a.length; i++) total += Math.abs(a[i]! - (b[i] ?? 0));
  return total;
}

/** Returns the label of the reference profile closest (by sumAbsDiff) to `profile`, plus the full diff map — the "which specific hook is this?" verdict this file relies on instead of a bare brightness threshold. */
function closestLabel(
  profile: readonly number[],
  references: ReadonlyMap<(typeof CANDIDATE_LABELS)[number], readonly number[]>
): { label: (typeof CANDIDATE_LABELS)[number]; diffs: Record<string, number> } {
  let best: (typeof CANDIDATE_LABELS)[number] = BLANK_LABEL;
  let bestDiff = Infinity;
  const diffs: Record<string, number> = {};
  for (const [label, ref] of references) {
    const d = sumAbsDiff(profile, ref);
    diffs[label] = d;
    if (d < bestDiff) {
      bestDiff = d;
      best = label;
    }
  }
  return { label: best, diffs };
}

async function buildReferenceProfiles(page: Page): Promise<ReadonlyMap<(typeof CANDIDATE_LABELS)[number], readonly number[]>> {
  const map = new Map<(typeof CANDIDATE_LABELS)[number], readonly number[]>();
  for (const label of CANDIDATE_LABELS) {
    map.set(label, await referenceColumnProfile(page, label));
  }
  return map;
}

interface HookGameCase {
  readonly name: string;
  readonly pgn: string;
  readonly expectedLabel: (typeof CANDIDATE_LABELS)[number];
}

const HOOK_GAMES: readonly HookGameCase[] = [
  { name: "Scholar's Mate", pgn: SCHOLARS_MATE, expectedLabel: 'CHECKMATE' },
  { name: 'Evergreen', pgn: EVERGREEN, expectedLabel: 'FORCED TRAP' },
  { name: 'Stalemate', pgn: STALEMATE, expectedLabel: 'STALEMATE' },
  { name: 'Promotion race', pgn: PROMOTION_RACE, expectedLabel: 'PAWN JOURNEY' }
];

for (const game of HOOK_GAMES) {
  test(`${game.name}: exported video's opening hook is specifically "${game.expectedLabel}" (matched against independent reference renders, not brightness alone)`, async ({ page }) => {
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => pageErrors.push(String(err)));

    await loadAnalyzeDirect(page, game.pgn);
    const webmBytes = await exportVideoBytes(page);
    const references = await buildReferenceProfiles(page);

    const atStart = await decodeHookZone(page, webmBytes, 0);
    expect(atStart.width, 'exported video width').toBe(EXPORT_WIDTH);
    expect(atStart.height, 'exported video height').toBe(EXPORT_HEIGHT);

    const verdict = closestLabel(atStart.columnAverages, references);
    expect(
      verdict.label,
      `t=0 hook region should match "${game.expectedLabel}"'s own reference render most closely; full diff map: ${JSON.stringify(verdict.diffs)}`
    ).toBe(game.expectedLabel);
    // The correct match must not be a coin flip against the blank baseline — real hook text must be present, not merely "not blank".
    expect(verdict.diffs[BLANK_LABEL]!, 't=0 hook region should differ substantially from the no-text baseline').toBeGreaterThan(HOOK_BACKGROUND_MAX * 10);

    // Geometric boundary: zero bleed into the board, and real board content confirmed present just below it.
    expect(atStart.boundaryBandAvg, 'rows just above the board boundary (y=400-420) must show no hook bleed').toBeLessThan(HOOK_BACKGROUND_MAX);
    expect(atStart.boardSampleAvg, 'rows just below the board boundary (y=420-460) must show real, non-blank board content').toBeGreaterThan(NOT_BLACK_THRESHOLD);

    // Timing: gone well after the ~1.0s total hook lifetime, with tolerance for frame quantization.
    const gone = await decodeHookZone(page, webmBytes, 1.2);
    const goneVerdict = closestLabel(gone.columnAverages, references);
    expect(goneVerdict.label, 'by t=1.2s the hook should have fully faded — region should match the blank baseline, not any hook text').toBe(BLANK_LABEL);

    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
  });
}

test('Promotion race: the opening hook is independently detectable at t=0 even though its own Moment spans the entire video', async ({ page }) => {
  // A prior investigation established (via a direct deriveCinematicMoments
  // query) that Promotion race's single Moment ("Pawn Journey") spans
  // atMs=0 to untilMs=sceneDurationMs — the entire video, unlike every
  // other canonical game. This test confirms the hook (a completely
  // separate, time-boxed signal keyed only on logicalTimeMs, never on
  // Moment state — see drawHook.ts's hookOpacityAt) and the bottom caption
  // (Moment-driven, always-on for this game) are both independently
  // present at the very first frame, proving no accidental coupling
  // between the two systems.
  await loadAnalyzeDirect(page, PROMOTION_RACE);
  const webmBytes = await exportVideoBytes(page);
  const references = await buildReferenceProfiles(page);

  const atStart = await decodeHookZone(page, webmBytes, 0);
  const verdict = closestLabel(atStart.columnAverages, references);
  expect(verdict.label, 'the top hook region at t=0 should read PAWN JOURNEY').toBe('PAWN JOURNEY');

  const captionZone = await page.evaluate(
    async ({ b64 }) => {
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
        await new Promise<void>((resolve, reject) => {
          const onSeeked = (): void => {
            video.removeEventListener('seeked', onSeeked);
            resolve();
          };
          video.addEventListener('seeked', onSeeked);
          video.currentTime = 0;
          setTimeout(() => reject(new Error('seek timeout')), 10_000);
        });
        const canvas = document.createElement('canvas');
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const ctx = canvas.getContext('2d')!;
        ctx.drawImage(video, 0, 0);
        const { data } = ctx.getImageData(0, canvas.height - 300, canvas.width, 300);
        let sum = 0;
        for (let i = 0; i < data.length; i += 4) sum += 0.299 * data[i]! + 0.587 * data[i + 1]! + 0.114 * data[i + 2]!;
        return sum / (data.length / 4);
      } finally {
        URL.revokeObjectURL(url);
        video.remove();
      }
    },
    { b64: webmBytes.toString('base64') }
  );
  expect(captionZone, 'the bottom caption zone should also show real (non-letterbox) content at t=0, independent of the hook').toBeGreaterThan(5);
});

test('Quiet: no opening hook text is ever introduced (verified via content-matching at multiple timestamps, not top-band brightness alone)', async ({ page }) => {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => pageErrors.push(String(err)));

  await loadAnalyzeDirect(page, QUIET);
  const webmBytes = await exportVideoBytes(page);
  const references = await buildReferenceProfiles(page);

  for (const fraction of [0, 0.5, 0.999]) {
    const duration = await videoDuration(page, webmBytes);
    const readout = await decodeHookZone(page, webmBytes, fraction * duration);
    const verdict = closestLabel(readout.columnAverages, references);
    expect(verdict.label, `at fraction ${fraction}: hook region must match the blank/no-text baseline, not any candidate hook string`).toBe(BLANK_LABEL);
    expect(Math.max(...readout.columnAverages), `at fraction ${fraction}: no column bucket in the hook region should show bright content`).toBeLessThan(
      HOOK_BACKGROUND_MAX
    );
  }

  expect(consoleErrors).toEqual([]);
  expect(pageErrors).toEqual([]);
});

test("opening hook timing: appears instantly at t=0, holds through ~0.5s, is mid-fade by ~0.9s, and is fully gone by ~1.2s (Scholar's Mate)", async ({
  page
}) => {
  await loadAnalyzeDirect(page, SCHOLARS_MATE);
  const webmBytes = await exportVideoBytes(page);

  const energyAt = async (timeSec: number): Promise<number> => {
    const readout = await decodeHookZone(page, webmBytes, timeSec);
    return Math.max(...readout.columnAverages);
  };

  // Sequential (not Promise.all): concurrent real-<video> decode calls
  // caused real resource contention at this resolution in prior phases of
  // this project (see portraitExport.spec.ts/captions.spec.ts).
  const e0 = await energyAt(0);
  const e05 = await energyAt(0.5);
  const e09 = await energyAt(0.9);
  const e12 = await energyAt(1.2);

  expect(e0, 't=0: hook should be fully visible').toBeGreaterThan(HOOK_BACKGROUND_MAX * 4);
  expect(e05, 't=0.5s: hook should still be fully visible (before the fade window starts)').toBeGreaterThan(e0 * 0.8);
  expect(e09, 't=0.9s: hook should be visibly dimmer than at t=0 (mid-fade)').toBeLessThan(e0 * 0.85);
  expect(e12, 't=1.2s: hook should be fully gone').toBeLessThan(HOOK_BACKGROUND_MAX);
});

test('Export PNG sequence and the on-screen preview remain 480x480 and carry no opening hook (hook is opt-in to Export Video only — see ui/panel.ts\'s handleExportVideo vs. handleExport)', async ({
  page
}) => {
  await loadAnalyzeDirect(page, SCHOLARS_MATE);

  // On-screen preview canvas: unrelated code path (render/Renderer.ts via
  // preview/PreviewLoop.ts) that never calls drawHook at all.
  const previewDims = await page.evaluate(() => {
    const canvas = document.querySelector('#board') as HTMLCanvasElement;
    return { width: canvas.width, height: canvas.height };
  });
  expect(previewDims.width, 'on-screen preview canvas width').toBe(480);
  expect(previewDims.height, 'on-screen preview canvas height').toBe(480);

  const pngZipBytes = await exportPngZipBytes(page);
  const pngBytes = extractFirstZipEntry(pngZipBytes);
  // PNG signature check — a real structural check on the extracted entry, not just "some bytes exist".
  expect(pngBytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');

  const pngDims = await page.evaluate(async (base64) => {
    const res = await fetch(`data:image/png;base64,${base64}`);
    const blob = await res.blob();
    const bitmap = await createImageBitmap(blob);
    const dims = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return dims;
  }, pngBytes.toString('base64'));

  // Square dims (no portrait letterbox at all) is the exact precondition
  // drawHook.ts's own letterboxHeight<=0 guard relies on — at 480x480,
  // letterboxHeight computes to 0 and drawHook safely no-ops. This is also
  // structurally guaranteed by construction: handleExport's runExport call
  // never sets `hook: true` (only handleExportVideo does), so PNG export
  // never even derives a hook, let alone draws one.
  expect(pngDims.width, 'PNG export width').toBe(480);
  expect(pngDims.height, 'PNG export height').toBe(480);
});
