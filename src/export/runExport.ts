import type { AppState } from '../state/AppState';
import type { AssetManager } from '../assets/AssetManager';
import type { RenderDims } from '../render/coords';
import { render } from '../render/Renderer';
import { deriveCinematicMoments, type CinematicMoment } from '../state/moments';
import { frameCount, frameIndexToTimeMs } from './FrameSource';
import { drawCaptions } from './drawCaptions';
import { drawHook, selectHook, type HookContent } from './drawHook';
import type { Encoder } from './Encoder';

/**
 * Renders exactly one export frame at the deterministic time for
 * frameIndex. Calls the same render/Renderer.render used by
 * preview/PreviewLoop.previewTick — see docs/architecture.md
 * Correction 6.
 */
export function renderExportFrame(
  state: AppState,
  frameIndex: number,
  fps: number,
  ctx: OffscreenCanvasRenderingContext2D,
  dims: RenderDims,
  assets: AssetManager<HTMLImageElement>
): void {
  const logicalTimeMs = frameIndexToTimeMs(frameIndex, fps);
  render(state, logicalTimeMs, ctx, dims, assets);
}

export interface RunExportOptions {
  fps: number;
  dims: RenderDims;
  onProgress?: (framesDone: number, framesTotal: number) => void;
  /**
   * Phase 6 — burns the Moments panel's own narrative text into export
   * frames. Explicit opt-in, defaulting to off/undefined: runExport is
   * shared by both "Export PNG sequence" and "Export Video"
   * (ui/panel.ts's handleExport/handleExportVideo both call this same
   * function with different Encoders), and the Phase 6 investigation
   * scoped captions to the video export only — the PNG sequence must stay
   * byte-for-byte unchanged. Only ui/panel.ts's video-export call site
   * sets this true.
   */
  captions?: boolean;
  /**
   * Phase 11 — burns a deterministic opening title card into the top
   * portrait letterbox. Explicit opt-in, same convention as `captions`:
   * only ui/panel.ts's video-export call site sets this true, so the
   * PNG-sequence export path never derives or draws a hook at all.
   */
  hook?: boolean;
}

/**
 * Phase 6 — the same CinematicMoment[] the Moments UI panel already
 * computes (state/moments.ts's deriveCinematicMoments), consumed here
 * read-only to burn captions into exported frames. Requires a completed
 * analysis AND a completed cinematic direction run (both may legitimately
 * be absent — e.g. a game exported straight off Phase 1's trivial
 * timeline, before "Generate Cinematic" is ever clicked); in that case
 * there is no narrative to show, so this safely returns no Moments rather
 * than failing the export.
 */
function momentsFor(state: AppState): readonly CinematicMoment[] {
  if (!state.game || !state.analysis.result || !state.direction.result) return [];
  const { cinematicPlan, understanding, story } = state.direction.result;
  return deriveCinematicMoments(cinematicPlan, state.game.timeline, state.analysis.result, understanding, story);
}

/**
 * Phase 11 — mirrors momentsFor's own guard exactly: a completed analysis
 * and cinematic direction run are both required (selectHook reads
 * story.archetypeSignals and analysis.plies), and are both legitimately
 * absent in the same pre-"Generate Cinematic" case momentsFor already
 * handles — safely no hook rather than a failed export.
 */
function hookFor(state: AppState): HookContent | null {
  if (!state.game || !state.analysis.result || !state.direction.result) return null;
  const { story } = state.direction.result;
  return selectHook(story, state.analysis.result);
}

/**
 * Phase 12A — a terminal-result caption (state/moments.ts's own
 * terminal-result-highlight Moment) naturally dwells for only the final
 * ply's own MoveBeat duration — as little as 300ms in every canonical
 * terminal game (see the Phase 12 investigation) — because that beat is
 * also the very last thing in the scene: there is no unused video time
 * after it to redirect the caption into. The only way to give a viewer
 * real time to read it without touching Director/story pacing (protected,
 * and any change there would ripple through every other Moment's timing)
 * is to export MORE frames than the scene itself contains, holding on the
 * scene's own final frame for a fixed extra duration.
 *
 * 1500ms — matches DEFAULT_DIRECTOR_SETTINGS's own heldMultiplier(2.5) *
 * baseMoveDurationMs(600) elsewhere in this system (director/types.ts,
 * read only for this reasoning, not imported or depended on here — see
 * the module comment above on restatement-over-coupling precedent this
 * project already established in drawHook.ts): the same order of
 * magnitude this codebase already treats as "long enough to register as a
 * deliberately held, important beat," reused here as an independent,
 * export-layer-only constant rather than a new dependency on director/*.
 */
export const TERMINAL_HOLD_MS = 1500;

/**
 * Pure: number of extra frames to append after the scene's own natural
 * frame count. Zero unless the chronologically LAST Moment is a
 * terminal-result-highlight — i.e. the exported game actually ended in
 * checkmate/stalemate/draw. Promotion race's own last (and only) Moment is
 * archetype-track (its final analyzed position is never terminal — see
 * drawHook.ts's own selectHook reasoning); Quiet has no Moments at all;
 * both correctly get 0 extra frames, unchanged from today. Checking the
 * *last* Moment's kind (rather than searching for any terminal-result-
 * highlight Moment) is still correct even in the hypothetical case — not
 * reached by any canonical game today — where the terminal directive gets
 * merged into an earlier-starting Moment group: state/moments.ts's own
 * KIND_PRIORITY ranks terminal-result-highlight above every other kind, so
 * a merged group containing it always reports that kind as the Moment's
 * own `kind` (read only here, not modified).
 */
export function terminalHoldFrameCount(moments: readonly CinematicMoment[], fps: number): number {
  const last = moments[moments.length - 1];
  if (!last || last.kind !== 'terminal-result-highlight') return 0;
  return frameCount(TERMINAL_HOLD_MS, fps);
}

/**
 * The logical time every held frame renders at. scene.durationMs itself is
 * the terminal Moment's own EXCLUSIVE untilMs (state/moments.ts's
 * deriveCinematicMoments) — drawCaptions.ts's activeMomentAt requires
 * logicalTimeMs < untilMs, so freezing exactly at scene.durationMs would
 * silently make the caption disappear for every held frame. One
 * millisecond earlier is still safely inside the terminal Moment's own
 * window (its dwell is always at least one MoveBeat, at minimum 300ms in
 * every canonical case) — and, confirmed against real exported frames from
 * all three terminal canonical games during the Phase 12 investigation, is
 * already extremely close to where render/resolveCamera.ts's own eased
 * post-climax zoom-out naturally lands (>99.9% of the way back to the
 * reset keyframe's zoom=1, full-board framing) by construction: this
 * freeze time is not a new or different camera state, it is the same
 * final, fully-revealed board position the export already settles on at
 * its own natural last frame today — held for longer, with no change to
 * camera mathematics at all.
 */
export function terminalHoldFreezeTimeMs(sceneDurationMs: number): number {
  return Math.max(0, sceneDurationMs - 1);
}

/**
 * Drives frame production and encoding with backpressure. Exactly one
 * frame is rendered into a single reused OffscreenCanvas, handed to the
 * encoder, and awaited before the next frame is rendered — no array of
 * frames or blobs is ever accumulated (docs/architecture.md
 * Correction 4). Frame timing is computed by FrameSource, never sampled
 * from a clock, so a given AppState always produces identical output.
 */
export async function runExport(
  state: AppState,
  assets: AssetManager<HTMLImageElement>,
  encoder: Encoder,
  opts: RunExportOptions
): Promise<Blob | null> {
  const scene = state.game?.timeline.scenes.find((s) => s.id === state.playback.activeSceneId);
  if (!state.game || !scene) {
    throw new Error('runExport: no loaded game or active scene to export');
  }

  const total = frameCount(scene.durationMs, opts.fps);

  // Computed once, outside the frame loop — deriveCinematicMoments is pure
  // and its inputs don't change frame to frame. Phase 6: burns the same
  // narrative already shown in the Moments UI panel into export frames
  // only (never into preview/PreviewLoop's own draw path — see
  // drawCaptions.ts's own module comment). Empty when opts.captions isn't
  // set, so the PNG-sequence export path never pays even the cost of
  // deriving Moments, let alone drawing them.
  const moments = opts.captions ? momentsFor(state) : [];
  // Same once-outside-the-loop reasoning as `moments` above — selectHook is
  // pure and its inputs (story.archetypeSignals, the final ply's own
  // evaluation) don't change frame to frame either. null when opts.hook
  // isn't set, so the PNG-sequence export path never derives a hook at all.
  const hook = opts.hook ? hookFor(state) : null;
  // Phase 12A — depends only on `moments`, which is already empty whenever
  // opts.captions isn't set, so this is 0 for the PNG-sequence export path
  // by construction, with no separate opt-in flag needed.
  const holdFrames = terminalHoldFrameCount(moments, opts.fps);
  const totalWithHold = total + holdFrames;
  const freezeTimeMs = terminalHoldFreezeTimeMs(scene.durationMs);

  await encoder.start({ width: opts.dims.width, height: opts.dims.height, fps: opts.fps });

  const canvas = new OffscreenCanvas(opts.dims.width, opts.dims.height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('runExport: could not acquire a 2D context on OffscreenCanvas');

  for (let frameIndex = 0; frameIndex < totalWithHold; frameIndex++) {
    const isHeldFrame = frameIndex >= total;
    const logicalTimeMs = isHeldFrame ? freezeTimeMs : frameIndexToTimeMs(frameIndex, opts.fps);
    if (isHeldFrame) {
      // Same render() call renderExportFrame wraps, but at the fixed
      // freeze time rather than one derived from frameIndex — every held
      // frame renders the identical, deterministic final frame.
      render(state, logicalTimeMs, ctx, opts.dims, assets);
    } else {
      renderExportFrame(state, frameIndex, opts.fps, ctx, opts.dims, assets);
    }
    if (opts.captions) drawCaptions(ctx, moments, logicalTimeMs, opts.dims);
    if (opts.hook) drawHook(ctx, hook, logicalTimeMs, opts.dims);
    await encoder.addFrame(canvas, frameIndex);
    opts.onProgress?.(frameIndex + 1, totalWithHold);
  }

  return encoder.finish();
}
