import { describe, expect, it } from 'vitest';
import { detectExportCapabilities, detectVp9VideoExportSupport } from './capabilities';

describe('detectExportCapabilities', () => {
  it('reports false for both capabilities when neither is present on the given scope', () => {
    const caps = detectExportCapabilities({} as typeof globalThis);
    expect(caps.offscreenCanvas).toBe(false);
    expect(caps.fileSystemAccess).toBe(false);
  });

  it('reports true when the given scope exposes both', () => {
    const fakeScope = { OffscreenCanvas: function () {}, showDirectoryPicker: () => {} } as unknown as typeof globalThis;
    const caps = detectExportCapabilities(fakeScope);
    expect(caps.offscreenCanvas).toBe(true);
    expect(caps.fileSystemAccess).toBe(true);
  });
});

describe('detectVp9VideoExportSupport', () => {
  it('reports unsupported with a clear reason when VideoEncoder is absent from the given scope', async () => {
    const result = await detectVp9VideoExportSupport({ width: 480, height: 480 }, 24, {} as typeof globalThis);
    expect(result.supported).toBe(false);
    expect(result.reason).toMatch(/WebCodecs/);
  });

  it('reports supported when isConfigSupported resolves { supported: true }', async () => {
    const fakeScope = {
      VideoEncoder: { isConfigSupported: async () => ({ supported: true }) }
    } as unknown as typeof globalThis;
    const result = await detectVp9VideoExportSupport({ width: 480, height: 480 }, 24, fakeScope);
    expect(result).toEqual({ supported: true });
  });

  it('reports unsupported with a clear reason when isConfigSupported resolves { supported: false }', async () => {
    const fakeScope = {
      VideoEncoder: { isConfigSupported: async () => ({ supported: false }) }
    } as unknown as typeof globalThis;
    const result = await detectVp9VideoExportSupport({ width: 480, height: 480 }, 24, fakeScope);
    expect(result.supported).toBe(false);
    expect(result.reason).toMatch(/no support for VP9/);
  });

  it('reports unsupported with a clear reason when isConfigSupported itself throws', async () => {
    const fakeScope = {
      VideoEncoder: {
        isConfigSupported: async () => {
          throw new Error('boom');
        }
      }
    } as unknown as typeof globalThis;
    const result = await detectVp9VideoExportSupport({ width: 480, height: 480 }, 24, fakeScope);
    expect(result.supported).toBe(false);
    expect(result.reason).toMatch(/VP9 support check failed: boom/);
  });

  it('is confirmed unsupported in this real Node test environment (no mocking) — matches Vp9VideoEncoder.test.ts', async () => {
    const result = await detectVp9VideoExportSupport({ width: 480, height: 480 }, 24);
    expect(result.supported).toBe(false);
  });
});
