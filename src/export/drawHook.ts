import type { StoryArchetype, StoryPlan } from '../story/types';
import type { GameAnalysis } from '../analysis/types';
import type { RenderDims } from '../render/coords';
import type { Ctx2D } from '../render/Ctx2D';

/**
 * Phase 11 — burns a deterministic opening title card into the top portrait
 * letterbox of exported video frames only. Mirrors drawCaptions.ts's own
 * split (pure selection/content logic here, testable without a real Canvas
 * 2D context; the actual draw call at the bottom, Playwright-only) and its
 * own module contract: called from export/runExport.ts, never from
 * render/Renderer.ts, so the live preview path never draws a hook and
 * render/Renderer.ts's Phase 9 clip (scoped to drawBoard/drawPieces/
 * drawAnnotations only) never touches this module at all.
 */

/** Deterministic, pre-rendered hook text — already in its final display form (uppercase; see selectHook). */
export interface HookContent {
  readonly text: string;
}

/**
 * Restated from state/moments.ts's own (unexported) ARCHETYPE_LABEL —
 * itself already a restatement of a director/annotations.ts constant, per
 * that file's own comment. state/moments.ts is out of scope for Phase 11
 * (only touch it if absolutely unavoidable — see the Phase 11 spec), so
 * this follows the exact same restatement precedent rather than exporting
 * a new symbol from it. Kept byte-identical in wording to moments.ts's own
 * table; only the uppercase transform below is new presentation, not new data.
 */
const ARCHETYPE_LABEL: Readonly<Record<StoryArchetype, string>> = {
  'king-hunt': 'King Hunt',
  'pawn-journey': 'Pawn Journey',
  'stalemate-swindle': 'Stalemate Swindle',
  'forced-trap': 'Forced Trap'
};

/**
 * Restated from state/moments.ts's own (unexported) ARCHETYPE_COLOR_ORDER,
 * same justification as ARCHETYPE_LABEL above — this is the one existing
 * archetype-priority resolution already used to pick a single primary
 * archetype whenever more than one signal shares a Moment (state/moments.ts's
 * own orderGroup). Reused verbatim here, not reinvented: the hook must
 * resolve Evergreen's forced-trap + king-hunt to "Forced Trap" — the exact
 * same winner the app's own Moments panel already shows as primary.
 */
const ARCHETYPE_COLOR_ORDER: Readonly<Record<StoryArchetype, number>> = {
  'forced-trap': 0,
  'king-hunt': 1,
  'pawn-journey': 2,
  'stalemate-swindle': 3
};

/**
 * Pure: (StoryPlan, GameAnalysis) -> HookContent | null, per the approved
 * Phase 11 hierarchy —
 *   Tier 1: story.archetypeSignals non-empty -> the existing primary
 *     archetype (ARCHETYPE_COLOR_ORDER tie-break, same resolution the app
 *     already uses — never a new hook-specific priority rule).
 *   Tier 2: otherwise, the final analyzed ply's own evaluation is
 *     kind==='terminal' -> the existing terminal result label
 *     (Checkmate/Stalemate/Draw, same three cases state/moments.ts's own
 *     terminalLabel distinguishes).
 *   Tier 3: neither holds -> null (no hook; e.g. Quiet, and Promotion
 *     race's own analysis ends at a plain evaluation, never a terminal
 *     one, which is exactly why archetype must be checked first).
 * Deliberately does NOT reuse terminalLabel's own 'Terminal' catch-all
 * fallback: that fallback is dead code in its real caller (only ever
 * invoked once a terminal-result-highlight Moment already exists, which
 * itself requires a terminal evaluation), but the hook's own Tier 2 is
 * reached whenever Tier 1 misses, terminal or not — so it must gate on
 * ev.kind==='terminal' explicitly and fall through to Tier 3 rather than
 * ever showing a bare "Terminal" placeholder.
 */
export function selectHook(story: StoryPlan, analysis: GameAnalysis): HookContent | null {
  if (story.archetypeSignals.length > 0) {
    const primary = [...story.archetypeSignals].sort(
      (a, b) => ARCHETYPE_COLOR_ORDER[a.archetype] - ARCHETYPE_COLOR_ORDER[b.archetype]
    )[0]!;
    return { text: ARCHETYPE_LABEL[primary.archetype].toUpperCase() };
  }

  const finalPly = analysis.plies[analysis.plies.length - 1];
  const ev = finalPly?.evaluationAfter;
  if (ev && ev.kind === 'terminal') {
    if (ev.result === 'draw') {
      return { text: (ev.drawReason === 'stalemate' ? 'Stalemate' : 'Draw').toUpperCase() };
    }
    return { text: 'CHECKMATE' };
  }

  return null;
}

/** Hook is fully opaque through this point, then linearly fades to 0 by HOOK_TOTAL_MS. */
export const HOOK_VISIBLE_MS = 800;
/** Fade duration — see hookOpacityAt. */
export const HOOK_FADE_MS = 200;
/** Total hook lifetime: 800ms fully visible + 200ms fade = 1000ms, per the approved Phase 11 design. */
export const HOOK_TOTAL_MS = HOOK_VISIBLE_MS + HOOK_FADE_MS;

/**
 * Pure: logicalTimeMs -> opacity in [0, 1]. Appears instantly at full
 * opacity (no fade-in — the approved design is explicit that the hook must
 * appear immediately, not ease in), holds through HOOK_VISIBLE_MS, then
 * fades linearly to 0 by HOOK_TOTAL_MS. Deliberately keyed only on
 * logicalTimeMs — never on Moment or camera-plan timing, so the hook's
 * lifetime has no coupling to Director/camera state at all.
 */
export function hookOpacityAt(logicalTimeMs: number): number {
  if (logicalTimeMs < HOOK_VISIBLE_MS) return 1;
  if (logicalTimeMs < HOOK_TOTAL_MS) return 1 - (logicalTimeMs - HOOK_VISIBLE_MS) / HOOK_FADE_MS;
  return 0;
}

export interface HookStyle {
  readonly textColor: string;
  readonly fontFamily: string;
}

/** Same font stack as drawCaptions.ts's own DEFAULT_CAPTION_STYLE — already verified to render/measure identically across on-screen <canvas> and OffscreenCanvas. */
export const DEFAULT_HOOK_STYLE: HookStyle = {
  textColor: '#ffffff',
  fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif'
};

/**
 * Larger than drawCaptions.ts's own label font (3.6% of width) — a title
 * card conventionally reads bigger than an in-context caption label.
 * Empirically measured against every real label this table can produce
 * (including "STALEMATE SWINDLE", the longest, at 780px) to fit
 * comfortably inside HOOK_MAX_WIDTH_FRACTION's own 972px budget at
 * 1080px width, with no wrapping and no dynamic shrinking required for
 * any string this codebase's closed archetype/terminal vocabulary can
 * ever actually produce.
 */
const HOOK_FONT_FRACTION = 0.06;
/** Matches drawCaptions.ts's own CAPTION_WIDTH_FRACTION exactly, for visual consistency between the two text systems. */
const HOOK_MAX_WIDTH_FRACTION = 0.9;

/**
 * Draws the opening hook — a single centered line in the top portrait
 * letterbox — with no scrim: that band is already unpainted (black once
 * VP9-encoded, no alpha channel — the same fact established in the Phase
 * 6/7A/9 investigations), so white text there already has full contrast
 * with no background needed. The vertical center is derived purely from
 * dims (never from camera/zoom state): computeViewport's own xOffset/
 * yOffset math (render/coords.ts, untouched by this module) already proves
 * the letterbox height — dims.height minus the narrower dimension, halved
 * — is invariant to zoom, so this reaches the same answer without
 * importing camera code at all. At square dims (PNG export / preview,
 * which never call this function) that height collapses to 0 and this
 * safely no-ops rather than drawing into the board.
 *
 * fillText's own optional maxWidth argument is the single-line overflow
 * guard (native, browser-applied horizontal compression) — deliberately
 * simpler than drawCaptions.ts's own wrapText/clampToMaxLines, since the
 * approved Phase 11 design is explicit that the hook is single-line only,
 * never wrapped.
 */
export function drawHook(ctx: Ctx2D, hook: HookContent | null, logicalTimeMs: number, dims: RenderDims, style: HookStyle = DEFAULT_HOOK_STYLE): void {
  if (!hook) return;
  const opacity = hookOpacityAt(logicalTimeMs);
  if (opacity <= 0) return;

  const letterboxHeight = (dims.height - Math.min(dims.width, dims.height)) / 2;
  if (letterboxHeight <= 0) return;

  const fontPx = Math.max(1, Math.round(dims.width * HOOK_FONT_FRACTION));
  const maxWidth = dims.width * HOOK_MAX_WIDTH_FRACTION;

  ctx.save();
  ctx.globalAlpha = opacity;
  ctx.font = `700 ${fontPx}px ${style.fontFamily}`;
  ctx.fillStyle = style.textColor;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(hook.text, dims.width / 2, letterboxHeight / 2, maxWidth);
  ctx.restore();
}
