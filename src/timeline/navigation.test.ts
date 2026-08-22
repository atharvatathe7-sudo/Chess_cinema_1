import { describe, expect, it } from 'vitest';
import {
  clampToScene,
  currentMoveNumber,
  nextBeatBoundaryMs,
  previousBeatBoundaryMs,
  totalMoveCount
} from './navigation';
import type { MoveBeat, Scene } from './types';

function moveBeat(overrides: Partial<MoveBeat>): MoveBeat {
  return {
    kind: 'move',
    san: '?',
    pieceId: 'w-p-e2',
    from: 'e2',
    to: 'e4',
    atMs: 0,
    durationMs: 600,
    isEnPassant: false,
    resultingPly: 1,
    ...overrides
  };
}

function sceneWithBeats(count: number, durationEach = 600): Scene {
  const beats: MoveBeat[] = Array.from({ length: count }, (_, i) =>
    moveBeat({ atMs: i * durationEach, durationMs: durationEach, resultingPly: i + 1, san: `m${i + 1}` })
  );
  return {
    id: 'scene-0',
    startPositionFen: 'startpos',
    startPly: 0,
    beats,
    cameraPlan: { keyframes: [{ atMs: 0, centerX: 4, centerY: 4, zoom: 1 }] },
    durationMs: count * durationEach
  };
}

describe('clampToScene', () => {
  const scene = sceneWithBeats(3); // duration 1800

  it('clamps negative time to 0', () => {
    expect(clampToScene(scene, -500)).toBe(0);
  });

  it('clamps time beyond duration to durationMs', () => {
    expect(clampToScene(scene, 5000)).toBe(1800);
  });

  it('leaves in-range time untouched', () => {
    expect(clampToScene(scene, 900)).toBe(900);
  });
});

describe('nextBeatBoundaryMs', () => {
  const scene = sceneWithBeats(3); // beats at 0, 600, 1200; duration 1800

  it('jumps to the next beat start from within the current beat', () => {
    expect(nextBeatBoundaryMs(scene, 0)).toBe(600);
    expect(nextBeatBoundaryMs(scene, 300)).toBe(600);
    expect(nextBeatBoundaryMs(scene, 600)).toBe(1200);
  });

  it('jumps to the scene end from within the last beat', () => {
    expect(nextBeatBoundaryMs(scene, 1200)).toBe(1800);
    expect(nextBeatBoundaryMs(scene, 1500)).toBe(1800);
  });

  it('is a no-op (stays at the end) once already at the end', () => {
    expect(nextBeatBoundaryMs(scene, 1800)).toBe(1800);
  });
});

describe('previousBeatBoundaryMs', () => {
  const scene = sceneWithBeats(3); // beats at 0, 600, 1200; duration 1800

  it('is a no-op (stays at 0) from within the first beat', () => {
    expect(previousBeatBoundaryMs(scene, 0)).toBe(0);
    expect(previousBeatBoundaryMs(scene, 300)).toBe(0);
  });

  it('jumps to the start of the immediately preceding beat', () => {
    expect(previousBeatBoundaryMs(scene, 600)).toBe(0);
    expect(previousBeatBoundaryMs(scene, 900)).toBe(600);
    expect(previousBeatBoundaryMs(scene, 1200)).toBe(600);
  });

  it('jumps to the start of the last beat when at the very end', () => {
    expect(previousBeatBoundaryMs(scene, 1800)).toBe(1200);
  });
});

describe('currentMoveNumber / totalMoveCount', () => {
  const scene = sceneWithBeats(3);

  it('reports move 1 at the very start', () => {
    expect(currentMoveNumber(scene, 0)).toBe(1);
  });

  it('reports the correct move mid-game', () => {
    expect(currentMoveNumber(scene, 900)).toBe(2);
  });

  it('reports the final move number at the end', () => {
    expect(currentMoveNumber(scene, 1800)).toBe(3);
  });

  it('totalMoveCount matches the number of move beats', () => {
    expect(totalMoveCount(scene)).toBe(3);
  });
});
