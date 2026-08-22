import { describe, expect, it } from 'vitest';
import type { Color, PieceType } from '../chess/ChessEngine';
import { AssetManager, type PieceManifest } from './AssetManager';

const PIECE_TYPES: PieceType[] = ['p', 'n', 'b', 'r', 'q', 'k'];
const COLORS: Color[] = ['w', 'b'];

function fakeManifest(): PieceManifest {
  const manifest = {} as PieceManifest;
  for (const color of COLORS) {
    manifest[color] = {} as Record<PieceType, string>;
    for (const type of PIECE_TYPES) {
      manifest[color][type] = `fake://${color}-${type}.svg`;
    }
  }
  return manifest;
}

describe('AssetManager', () => {
  it('starts in the loading state', () => {
    const manager = new AssetManager(fakeManifest(), async (url) => ({ url }));
    expect(manager.getState()).toBe('loading');
    expect(manager.getPieceImage('w', 'p')).toBeNull();
  });

  it('transitions to ready and exposes every loaded image once all succeed', async () => {
    const manager = new AssetManager(fakeManifest(), async (url) => ({ url }));
    const result = await manager.load();

    expect(result.ok).toBe(true);
    expect(manager.getState()).toBe('ready');
    for (const color of COLORS) {
      for (const type of PIECE_TYPES) {
        expect(manager.getPieceImage(color, type)).toEqual({ url: `fake://${color}-${type}.svg` });
      }
    }
  });

  it('transitions to error and never returns an image if any load fails', async () => {
    const manager = new AssetManager(fakeManifest(), async (url) => {
      if (url.includes('b-k')) throw new Error('boom');
      return { url };
    });

    const result = await manager.load();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.severity).toBe('fatal');
      expect(result.error.code).toBe('assets/piece-set-load-failed');
    }
    expect(manager.getState()).toBe('error');
    // no partial/stale image exposure on failure, even for pieces that loaded fine
    expect(manager.getPieceImage('w', 'p')).toBeNull();
  });
});
