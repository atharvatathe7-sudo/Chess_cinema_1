import type { CinematicMoment } from '../state/moments';
import type { RenderDims } from '../render/coords';
import type { Ctx2D } from '../render/Ctx2D';

/**
 * Phase 6 — burns the EXISTING deterministic Moment/narrative text
 * (state/moments.ts's CinematicMoment[], already consumed by the Moments
 * UI panel) into exported video frames. This module is export-only: it is
 * called from export/runExport.ts, never from render/Renderer.ts, so the
 * live preview path (preview/PreviewLoop.ts) never draws captions — see
 * the Phase 6 investigation's Section C (Option B).
 *
 * Every timing/text value here is read, not invented: activeMomentAt uses
 * exactly the same half-open [atMs, untilMs) convention
 * render/drawAnnotations.ts already uses, and only moment.label/
 * moment.reason (the primary narrative — narratives[0], never the
 * secondary "Also true" entries) are drawn.
 */

/**
 * moments is expected sorted ascending by atMs with non-overlapping
 * windows (deriveCinematicMoments's own guarantee — overlapping
 * directives are merged into one Moment before atMs/untilMs are
 * assigned), so the first interval containing logicalTimeMs is the only
 * one that ever can. Same exclusive-untilMs convention as
 * render/drawAnnotations.ts's own beat.atMs/beat.untilMs check.
 */
export function activeMomentAt(moments: readonly CinematicMoment[], logicalTimeMs: number): CinematicMoment | null {
  for (const moment of moments) {
    if (logicalTimeMs >= moment.atMs && logicalTimeMs < moment.untilMs) return moment;
  }
  return null;
}

/** Measures text width without requiring a full Ctx2D — satisfied by `(text) => ctx.measureText(text).width` in real drawing, and by a synthetic width function in tests (no canvas/DOM needed, matching vitest.config.ts's pure-logic-only convention). */
export type MeasureTextWidth = (text: string) => number;

/**
 * Deterministic greedy word wrap: appends words to the current line while
 * it still fits maxWidth, otherwise starts a new line. No hyphenation, no
 * external library — the same algorithm empirically verified against real
 * Canvas 2D/OffscreenCanvas measureText during the Phase 6 investigation.
 * A single word wider than maxWidth is kept whole on its own line rather
 * than broken mid-word (never truncated silently).
 */
export function wrapText(measureWidth: MeasureTextWidth, text: string, maxWidth: number): string[] {
  const words = text.split(' ').filter((w) => w.length > 0);
  if (words.length === 0) return [];

  const lines: string[] = [];
  let current = words[0]!;
  for (let i = 1; i < words.length; i++) {
    const word = words[i]!;
    const candidate = `${current} ${word}`;
    if (measureWidth(candidate) > maxWidth) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  lines.push(current);
  return lines;
}

const ELLIPSIS = '…';

/**
 * Clamps an already-wrapped line list to at most maxLines, collapsing any
 * overflow into a single final line truncated (word-by-word, deterministic)
 * to fit maxWidth with a trailing ellipsis. A no-op when lines already fit.
 */
export function clampToMaxLines(measureWidth: MeasureTextWidth, lines: readonly string[], maxWidth: number, maxLines: number): string[] {
  const limit = Math.max(1, maxLines);
  if (lines.length <= limit) return [...lines];

  const kept = lines.slice(0, limit - 1);
  const overflowWords = lines
    .slice(limit - 1)
    .join(' ')
    .split(' ')
    .filter((w) => w.length > 0);

  let last = overflowWords.join(' ');
  while (last.length > 0 && measureWidth(`${last}${ELLIPSIS}`) > maxWidth) {
    const trimmed = last.slice(0, -1).trimEnd();
    if (trimmed === last) break; // defense-in-depth against a non-terminating trim on pathological input
    last = trimmed;
  }
  kept.push(`${last}${ELLIPSIS}`);
  return kept;
}

/** Reason text never exceeds this many lines — overflow is clamped with an ellipsis rather than growing the caption band indefinitely. */
export const MAX_REASON_LINES = 2;

export interface CaptionContent {
  readonly label: string;
  readonly reasonLines: readonly string[];
}

/**
 * Pure: picks the primary narrative only (moment.label/moment.reason —
 * always narratives[0], per state/moments.ts's own guarantee — never any
 * of moment.narratives[1:], the secondary "Also true" entries the Moments
 * panel shows separately) and wraps the reason to at most maxReasonLines.
 * Split out from drawCaptions so this selection/wrapping logic is testable
 * without a real Canvas 2D context (vitest.config.ts covers pure-logic
 * unit tests only — see drawCaptions.test.ts).
 */
export function buildCaptionContent(measureWidth: MeasureTextWidth, moment: CinematicMoment, maxWidth: number, maxReasonLines: number = MAX_REASON_LINES): CaptionContent {
  const wrapped = wrapText(measureWidth, moment.reason, maxWidth);
  const reasonLines = clampToMaxLines(measureWidth, wrapped, maxWidth, maxReasonLines);
  return { label: moment.label, reasonLines };
}

export interface CaptionStyle {
  readonly scrimColor: string;
  readonly labelColor: string;
  readonly reasonColor: string;
  readonly fontFamily: string;
}

/** No web fonts, no new dependency — the same system font stack empirically verified during the Phase 6 investigation to render and measure identically across on-screen <canvas> and OffscreenCanvas. */
export const DEFAULT_CAPTION_STYLE: CaptionStyle = {
  scrimColor: 'rgba(0, 0, 0, 0.55)',
  labelColor: '#ffffff',
  reasonColor: '#e6e6e6',
  fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif'
};

const CAPTION_WIDTH_FRACTION = 0.9;
const LABEL_FONT_FRACTION = 0.036;
const REASON_FONT_FRACTION = 0.03;
const BAND_PADDING_FRACTION = 0.025;
const LABEL_LINE_HEIGHT_MULTIPLIER = 1.25;
const REASON_LINE_HEIGHT_MULTIPLIER = 1.3;
const LABEL_REASON_GAP_MULTIPLIER = 0.3;

/**
 * Draws the active Moment's primary narrative (label + up to
 * MAX_REASON_LINES lines of reason) as a bottom-anchored caption band with
 * a semi-transparent scrim, sized entirely as a fraction of dims.width/
 * dims.height — resolution-independent by construction, since export dims
 * are derived live from the on-screen board size and devicePixelRatio
 * (ui/panel.ts), never a fixed constant. No-op when no Moment is active at
 * logicalTimeMs.
 */
export function drawCaptions(ctx: Ctx2D, moments: readonly CinematicMoment[], logicalTimeMs: number, dims: RenderDims, style: CaptionStyle = DEFAULT_CAPTION_STYLE): void {
  const moment = activeMomentAt(moments, logicalTimeMs);
  if (!moment) return;

  const labelFontPx = Math.max(1, Math.round(dims.width * LABEL_FONT_FRACTION));
  const reasonFontPx = Math.max(1, Math.round(dims.width * REASON_FONT_FRACTION));
  const padding = dims.width * BAND_PADDING_FRACTION;
  const maxWidth = dims.width * CAPTION_WIDTH_FRACTION;
  const labelLineHeight = labelFontPx * LABEL_LINE_HEIGHT_MULTIPLIER;
  const reasonLineHeight = reasonFontPx * REASON_LINE_HEIGHT_MULTIPLIER;
  const labelReasonGap = reasonFontPx * LABEL_REASON_GAP_MULTIPLIER;

  ctx.save();

  ctx.font = `${reasonFontPx}px ${style.fontFamily}`;
  const measureWidth: MeasureTextWidth = (text) => ctx.measureText(text).width;
  const content = buildCaptionContent(measureWidth, moment, maxWidth);

  const bandHeight = padding * 2 + labelLineHeight + labelReasonGap + content.reasonLines.length * reasonLineHeight;
  const bandTop = dims.height - bandHeight;

  ctx.fillStyle = style.scrimColor;
  ctx.fillRect(0, bandTop, dims.width, bandHeight);

  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';
  const textX = padding;
  let textY = bandTop + padding;

  ctx.font = `700 ${labelFontPx}px ${style.fontFamily}`;
  ctx.fillStyle = style.labelColor;
  ctx.fillText(content.label, textX, textY);
  textY += labelLineHeight + labelReasonGap;

  ctx.font = `${reasonFontPx}px ${style.fontFamily}`;
  ctx.fillStyle = style.reasonColor;
  for (const line of content.reasonLines) {
    ctx.fillText(line, textX, textY);
    textY += reasonLineHeight;
  }

  ctx.restore();
}
