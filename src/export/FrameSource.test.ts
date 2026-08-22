import { describe, expect, it } from 'vitest';
import { frameCount, frameIndexToTimeMs } from './FrameSource';

describe('frameIndexToTimeMs', () => {
  it('computes time arithmetically from frame index and fps', () => {
    expect(frameIndexToTimeMs(0, 30)).toBe(0);
    expect(frameIndexToTimeMs(30, 30)).toBe(1000);
    expect(frameIndexToTimeMs(15, 30)).toBe(500);
  });

  it('is a pure function: identical inputs always give identical output', () => {
    expect(frameIndexToTimeMs(7, 24)).toBe(frameIndexToTimeMs(7, 24));
  });
});

describe('frameCount', () => {
  it('computes the number of frames for a given duration and fps', () => {
    expect(frameCount(1000, 30)).toBe(30);
    expect(frameCount(600, 30)).toBe(18);
  });

  it('never returns a negative count', () => {
    expect(frameCount(-500, 30)).toBe(0);
  });
});
