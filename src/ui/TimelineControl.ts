/**
 * A touch-friendly, Pointer-Events-driven scrub bar. Purely a DOM/input
 * component: it knows nothing about AppState, the Store, or actions —
 * it only reports "the user wants logicalTimeMs to be X" via onSeek and
 * displays whatever setValue() is told to display. All state mutation
 * happens in the caller (ui/panel.ts), which is the only place that
 * dispatches the existing seekTo/setPlaying actions. This keeps the
 * timeline data model the single source of truth: this component holds
 * no independent notion of playback position of its own between calls.
 *
 * The entire track is the interactive surface (not just a small thumb)
 * so the touch target is generous on a phone; tapping anywhere jumps
 * there immediately, and dragging continues to scrub via one captured
 * pointer (setPointerCapture), which is what lets a finger drag off the
 * exact pixel row of the track without losing the gesture — standard
 * practice for a touch slider, and exactly what "pointer capture" is for.
 */

const HIT_AREA_HEIGHT = 44; // generous mobile touch target
const TRACK_HEIGHT = 8;
const THUMB_SIZE = 22;

export interface TimelineControlOptions {
  onSeek: (logicalTimeMs: number) => void;
  onDragStart?: () => void;
}

export interface TimelineControlHandle {
  /** Reflects the current playback position/duration in the control's visuals. */
  setValue(currentMs: number, durationMs: number): void;
}

export function mountTimelineControl(container: HTMLElement, options: TimelineControlOptions): TimelineControlHandle {
  container.innerHTML = `
    <div class="tc-hitarea" style="position:relative;height:${HIT_AREA_HEIGHT}px;display:flex;align-items:center;touch-action:none;cursor:pointer;-webkit-tap-highlight-color:transparent;">
      <div class="tc-track" style="position:relative;width:100%;height:${TRACK_HEIGHT}px;background:#dcdcdc;border-radius:${TRACK_HEIGHT / 2}px;overflow:hidden;">
        <div class="tc-fill" style="position:absolute;left:0;top:0;bottom:0;width:0%;background:#3a5bfd;"></div>
      </div>
      <div class="tc-thumb" style="position:absolute;left:0%;top:50%;width:${THUMB_SIZE}px;height:${THUMB_SIZE}px;margin-left:${-THUMB_SIZE / 2}px;margin-top:${-THUMB_SIZE / 2}px;background:#3a5bfd;border:2px solid #fff;border-radius:50%;box-shadow:0 1px 4px rgba(0,0,0,0.35);pointer-events:none;"></div>
    </div>
  `;

  const hitArea = container.querySelector<HTMLDivElement>('.tc-hitarea')!;
  const fill = container.querySelector<HTMLDivElement>('.tc-fill')!;
  const thumb = container.querySelector<HTMLDivElement>('.tc-thumb')!;

  let durationMs = 0;
  let dragging = false;

  function render(currentMs: number): void {
    const pct = durationMs > 0 ? Math.max(0, Math.min(1, currentMs / durationMs)) * 100 : 0;
    fill.style.width = `${pct}%`;
    thumb.style.left = `${pct}%`;
  }

  function timeFromClientX(clientX: number): number {
    const rect = hitArea.getBoundingClientRect();
    const fraction = rect.width > 0 ? (clientX - rect.left) / rect.width : 0;
    return Math.max(0, Math.min(1, fraction)) * durationMs;
  }

  function handlePointerDown(e: PointerEvent): void {
    if (durationMs <= 0) return;
    dragging = true;
    // setPointerCapture can throw (NotFoundError) if the browser doesn't
    // consider this pointer "active" at the moment of the call — capture
    // is purely an enhancement so a drag survives the finger/cursor
    // leaving the track's exact pixels; losing it should never block the
    // seek itself or crash the handler.
    try {
      hitArea.setPointerCapture(e.pointerId);
    } catch {
      // continue without capture — pointermove still fires for drags
      // that stay within the track's own bounds.
    }
    options.onDragStart?.();
    options.onSeek(timeFromClientX(e.clientX));
  }

  function handlePointerMove(e: PointerEvent): void {
    if (!dragging) return;
    options.onSeek(timeFromClientX(e.clientX));
  }

  function endDrag(e: PointerEvent): void {
    if (!dragging) return;
    dragging = false;
    try {
      if (hitArea.hasPointerCapture(e.pointerId)) {
        hitArea.releasePointerCapture(e.pointerId);
      }
    } catch {
      // capture may already have been implicitly released by the browser; nothing to do.
    }
  }

  hitArea.addEventListener('pointerdown', handlePointerDown);
  hitArea.addEventListener('pointermove', handlePointerMove);
  hitArea.addEventListener('pointerup', endDrag);
  hitArea.addEventListener('pointercancel', endDrag);

  return {
    setValue(currentMs: number, nextDurationMs: number): void {
      durationMs = nextDurationMs;
      render(currentMs);
    }
  };
}
