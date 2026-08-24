import { describe, expect, it } from 'vitest';
import { Vp9VideoEncoder, estimateVp9Bitrate } from './Vp9VideoEncoder';

/**
 * This project's own testing split (see vitest.config.ts's comment)
 * keeps anything needing real Canvas 2D / browser APIs in Playwright —
 * Node has no WebCodecs (confirmed: `typeof VideoEncoder === 'undefined'`
 * here), so the actual encode/flush/keyframe-interval behavior is
 * exercised for real in tests/e2e/videoExport.spec.ts against Chromium.
 * What's genuinely testable under Node is the "unsupported browser"
 * failure path (a real code path here, not a mock — VideoEncoder truly
 * doesn't exist in this environment) and the pure bitrate heuristic.
 */
describe('Vp9VideoEncoder', () => {
  it('estimateVp9Bitrate stays within a sane fixed range across small and large export sizes', () => {
    expect(estimateVp9Bitrate(480, 480, 24)).toBeGreaterThanOrEqual(500_000);
    expect(estimateVp9Bitrate(480, 480, 24)).toBeLessThanOrEqual(8_000_000);
    expect(estimateVp9Bitrate(4000, 4000, 60)).toBe(8_000_000); // clamped at the ceiling for a size/fps combination far beyond anything this app renders
    expect(estimateVp9Bitrate(1, 1, 1)).toBe(500_000); // clamped at the floor for a degenerate tiny export
  });

  it('estimateVp9Bitrate is a pure, deterministic function of its inputs', () => {
    expect(estimateVp9Bitrate(800, 600, 24)).toBe(estimateVp9Bitrate(800, 600, 24));
  });

  it('start() rejects with a clear error when WebCodecs VideoEncoder is unavailable (this Node environment genuinely lacks it)', async () => {
    expect(typeof (globalThis as { VideoEncoder?: unknown }).VideoEncoder).toBe('undefined');
    const encoder = new Vp9VideoEncoder();
    await expect(encoder.start({ width: 80, height: 60, fps: 24 })).rejects.toThrow(/WebCodecs VideoEncoder is not available/);
  });

  it('addFrame() before start() throws a clear error', async () => {
    const encoder = new Vp9VideoEncoder();
    const fakeCanvas = {} as OffscreenCanvas;
    await expect(encoder.addFrame(fakeCanvas, 0)).rejects.toThrow(/before start/);
  });

  it('finish() before start() throws a clear error', async () => {
    const encoder = new Vp9VideoEncoder();
    await expect(encoder.finish()).rejects.toThrow(/before start/);
  });
});
