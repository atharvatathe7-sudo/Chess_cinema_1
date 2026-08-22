import type { PieceManifest } from './AssetManager';

// Vite resolves these to hashed, bundled asset URLs at build time.
import wp from './pieces/w-p.svg?url';
import wn from './pieces/w-n.svg?url';
import wb from './pieces/w-b.svg?url';
import wr from './pieces/w-r.svg?url';
import wq from './pieces/w-q.svg?url';
import wk from './pieces/w-k.svg?url';
import bp from './pieces/b-p.svg?url';
import bn from './pieces/b-n.svg?url';
import bb from './pieces/b-b.svg?url';
import br from './pieces/b-r.svg?url';
import bq from './pieces/b-q.svg?url';
import bk from './pieces/b-k.svg?url';

/**
 * Phase 1 placeholder piece set: flat vector shapes (not font glyphs),
 * so rendering does not depend on which fonts happen to be installed on
 * the machine (see docs/architecture.md §11). Visual quality is
 * explicitly deferred — this validates the asset-loading architecture,
 * not final art.
 */
export const PIECE_MANIFEST: PieceManifest = {
  w: { p: wp, n: wn, b: wb, r: wr, q: wq, k: wk },
  b: { p: bp, n: bn, b: bb, r: br, q: bq, k: bk }
};
