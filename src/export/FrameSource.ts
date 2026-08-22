/**
 * Pure, deterministic mapping from frame index to logical time. Never
 * sampled from a clock — given the same fps and frame index, this
 * always returns the same time, which is what makes export
 * frame-for-frame reproducible regardless of machine speed
 * (docs/architecture.md §10).
 */
export function frameIndexToTimeMs(frameIndex: number, fps: number): number {
  return (frameIndex / fps) * 1000;
}

export function frameCount(durationMs: number, fps: number): number {
  return Math.max(0, Math.round((durationMs / 1000) * fps));
}
