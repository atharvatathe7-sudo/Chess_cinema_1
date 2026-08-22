import { describe, expect, it } from 'vitest';
import { resolveCamera } from './resolveCamera';
import type { CameraPlan } from '../timeline/types';

describe('resolveCamera', () => {
  it('returns the single keyframe unchanged regardless of time (Phase 1 static camera)', () => {
    const plan: CameraPlan = { keyframes: [{ atMs: 0, centerX: 4, centerY: 4, zoom: 1 }] };
    expect(resolveCamera(plan, 0)).toEqual({ centerX: 4, centerY: 4, zoom: 1 });
    expect(resolveCamera(plan, 5000)).toEqual({ centerX: 4, centerY: 4, zoom: 1 });
  });

  it('is a pure function: repeated calls with the same input give the same output', () => {
    const plan: CameraPlan = { keyframes: [{ atMs: 0, centerX: 4, centerY: 4, zoom: 1 }] };
    const a = resolveCamera(plan, 300);
    const b = resolveCamera(plan, 300);
    expect(a).toEqual(b);
  });

  it('interpolates between two keyframes, clamping before/after the span', () => {
    const plan: CameraPlan = {
      keyframes: [
        { atMs: 0, centerX: 4, centerY: 4, zoom: 1 },
        { atMs: 1000, centerX: 6, centerY: 2, zoom: 2 }
      ]
    };
    expect(resolveCamera(plan, -100)).toEqual({ centerX: 4, centerY: 4, zoom: 1 });
    expect(resolveCamera(plan, 2000)).toEqual({ centerX: 6, centerY: 2, zoom: 2 });

    const mid = resolveCamera(plan, 500);
    expect(mid.centerX).toBeGreaterThan(4);
    expect(mid.centerX).toBeLessThan(6);
    expect(mid.zoom).toBeGreaterThan(1);
    expect(mid.zoom).toBeLessThan(2);
  });
});
