import type { AnnotationBeat, Scene } from '../timeline/types';
import { boardToPixel, computeViewport, squareCenter, squareToTopLeft, type BoardPoint, type Camera, type RenderDims } from './coords';
import type { Ctx2D } from './Ctx2D';

/**
 * Draws whatever annotations are active at logicalTimeMs. Phase 1's
 * trivial timeline generator never emits any AnnotationBeats, but this
 * function is fully data-driven off Scene.beats — a future
 * motif/story/direction generator can add highlights, arrows, or labels
 * without any renderer change (docs/architecture.md §15).
 */
export function drawAnnotations(ctx: Ctx2D, scene: Scene, logicalTimeMs: number, camera: Camera, dims: RenderDims): void {
  const annotationBeats = scene.beats.filter((b): b is AnnotationBeat => b.kind === 'annotation');

  for (const beat of annotationBeats) {
    if (logicalTimeMs < beat.atMs || logicalTimeMs >= beat.untilMs) continue;
    const { annotation } = beat;

    if (annotation.type === 'highlight') {
      const { scale } = computeViewport(camera, dims);
      ctx.save();
      ctx.globalAlpha = 0.35;
      ctx.fillStyle = annotation.color;
      for (const square of annotation.squares) {
        const topLeft = boardToPixel(camera, dims, squareToTopLeft(square, false));
        ctx.fillRect(topLeft.x, topLeft.y, scale, scale);
      }
      ctx.restore();
    } else if (annotation.type === 'arrow') {
      const [fromSquare, toSquare] = annotation.squares;
      if (fromSquare && toSquare) {
        const from = boardToPixel(camera, dims, squareCenter(fromSquare, false));
        const to = boardToPixel(camera, dims, squareCenter(toSquare, false));
        drawArrow(ctx, from, to, annotation.color);
      }
    }
    // 'label' is a reserved annotation type — no Phase 1 generator emits it yet.
  }
}

function drawArrow(ctx: Ctx2D, from: BoardPoint, to: BoardPoint, color: string): void {
  const headLength = 14;
  const angle = Math.atan2(to.y - from.y, to.x - from.x);

  ctx.save();
  ctx.globalAlpha = 0.8;
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 6;
  ctx.lineCap = 'round';

  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.lineTo(to.x, to.y);
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(to.x, to.y);
  ctx.lineTo(to.x - headLength * Math.cos(angle - Math.PI / 6), to.y - headLength * Math.sin(angle - Math.PI / 6));
  ctx.lineTo(to.x - headLength * Math.cos(angle + Math.PI / 6), to.y - headLength * Math.sin(angle + Math.PI / 6));
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}
