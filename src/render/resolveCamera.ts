import type { CameraPlan } from '../timeline/types';
import { easeOutCubic, type Camera } from './coords';

/**
 * Pure derivation of "what is the camera right now" from CameraPlan +
 * time — never stored anywhere (docs/architecture.md Correction 1).
 * Phase 1's trivial timeline only ever produces a single static
 * keyframe, but this handles an arbitrary keyframe list so later,
 * richer camera plans (cinematic direction) need no renderer change.
 */
export function resolveCamera(plan: CameraPlan, logicalTimeMs: number): Camera {
  const keyframes = plan.keyframes;
  const first = keyframes[0];
  if (!first) {
    throw new Error('resolveCamera: CameraPlan has no keyframes');
  }
  if (keyframes.length === 1 || logicalTimeMs <= first.atMs) {
    return { centerX: first.centerX, centerY: first.centerY, zoom: first.zoom };
  }

  for (let i = 0; i < keyframes.length - 1; i++) {
    const a = keyframes[i]!;
    const b = keyframes[i + 1]!;
    if (logicalTimeMs >= a.atMs && logicalTimeMs <= b.atMs) {
      const span = b.atMs - a.atMs;
      const t = span === 0 ? 1 : easeOutCubic((logicalTimeMs - a.atMs) / span);
      return {
        centerX: a.centerX + (b.centerX - a.centerX) * t,
        centerY: a.centerY + (b.centerY - a.centerY) * t,
        zoom: a.zoom + (b.zoom - a.zoom) * t
      };
    }
  }

  const last = keyframes[keyframes.length - 1]!;
  return { centerX: last.centerX, centerY: last.centerY, zoom: last.zoom };
}
