import type { AppState } from '../state/AppState';
import type { Store } from '../state/store';
import { advancePlayback } from '../state/actions';
import { render } from '../render/Renderer';
import type { RenderDims } from '../render/coords';
import type { Ctx2D } from '../render/Ctx2D';
import type { AssetManager } from '../assets/AssetManager';

/**
 * Renders exactly one preview frame at the store's current
 * playback.logicalTimeMs. This is the entire preview-side drawing
 * surface — it calls render/Renderer.render and does nothing else, so
 * there is no second implementation of board/piece/annotation drawing
 * anywhere in the preview path (docs/architecture.md Correction 6).
 */
export function previewTick(
  store: Store<AppState>,
  ctx: Ctx2D,
  dims: RenderDims,
  assets: AssetManager<HTMLImageElement>
): void {
  const state = store.getState();
  render(state, state.playback.logicalTimeMs, ctx, dims, assets);
}

/**
 * Drives previewTick with a requestAnimationFrame loop and a virtual
 * clock (playback.logicalTimeMs), advanced by real elapsed time while
 * playing. The clock — not Date.now()/performance.now() directly — is
 * what the renderer ever sees; see advancePlayback in state/actions.ts.
 */
export class PreviewLoop {
  private rafId: number | null = null;
  private lastFrameTime: number | null = null;

  constructor(
    private readonly store: Store<AppState>,
    private readonly ctx: Ctx2D,
    private readonly dims: RenderDims,
    private readonly assets: AssetManager<HTMLImageElement>
  ) {}

  start(): void {
    if (this.rafId !== null) return;
    this.lastFrameTime = null;
    const frame = (now: number): void => {
      if (this.lastFrameTime !== null) {
        advancePlayback(this.store, now - this.lastFrameTime);
      }
      this.lastFrameTime = now;
      previewTick(this.store, this.ctx, this.dims, this.assets);
      this.rafId = requestAnimationFrame(frame);
    };
    this.rafId = requestAnimationFrame(frame);
  }

  stop(): void {
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    this.rafId = null;
    this.lastFrameTime = null;
  }
}
