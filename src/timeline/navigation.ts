import type { MoveBeat, Scene } from './types';

function moveBeats(scene: Scene): MoveBeat[] {
  return scene.beats.filter((b): b is MoveBeat => b.kind === 'move');
}

/**
 * Clamps a candidate logicalTimeMs to the playable range of a scene
 * ([0, durationMs]). The single place scrubbing/navigation correctness
 * against out-of-range input is enforced — see state/actions.ts's
 * seekTo, which is the only thing allowed to write playback.logicalTimeMs.
 */
export function clampToScene(scene: Scene, logicalTimeMs: number): number {
  return Math.max(0, Math.min(scene.durationMs, logicalTimeMs));
}

/**
 * The time to jump to for "Next Move": the start of the next beat after
 * currentMs, or the end of the scene if currentMs is already in or past
 * the last beat. Pure — derived entirely from Scene.beats, the
 * authoritative timing source (docs/architecture.md Correction 2); it
 * does not read or write any playback state itself.
 */
export function nextBeatBoundaryMs(scene: Scene, currentMs: number): number {
  const next = moveBeats(scene)
    .map((b) => b.atMs)
    .filter((atMs) => atMs > currentMs)
    .sort((a, b) => a - b)[0];
  return next !== undefined ? next : scene.durationMs;
}

/**
 * The time to jump to for "Previous Move": the start of the previous
 * beat before currentMs, or the very start of the scene if currentMs is
 * already at or before the first beat.
 */
export function previousBeatBoundaryMs(scene: Scene, currentMs: number): number {
  const candidates = moveBeats(scene)
    .map((b) => b.atMs)
    .filter((atMs) => atMs < currentMs);
  return candidates.length > 0 ? Math.max(...candidates) : 0;
}

/** 1-indexed ply number currently in progress or just completed, for a "Move N / total" display. */
export function currentMoveNumber(scene: Scene, currentMs: number): number {
  return moveBeats(scene).filter((b) => b.atMs <= currentMs).length;
}

export function totalMoveCount(scene: Scene): number {
  return moveBeats(scene).length;
}
