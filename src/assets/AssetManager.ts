import { err, ok, type Result } from '../errors/Result';
import type { AppError } from '../errors/AppError';
import { assetLoadError } from './assetErrors';
import type { Color, PieceType } from '../chess/ChessEngine';

export type AssetLoadState = 'loading' | 'ready' | 'error';

export type PieceManifest = Record<Color, Record<PieceType, string>>;
export type PieceImages<TImage> = Record<Color, Record<PieceType, TImage>>;

/**
 * Loads and holds the piece art. Generic over the concrete image type so
 * it can be unit-tested in Node (with a fake loader resolving to a plain
 * object) without a real DOM/Image dependency; production code wires it
 * with a real `Image()`-backed loader (see browserPieceLoader.ts).
 *
 * State is explicit and exhaustive: 'loading' -> 'ready' | 'error'.
 * getPieceImage only ever returns an image once the *entire* manifest
 * has loaded successfully; in every other state it returns null, never
 * a stale or placeholder image. A load failure is fatal — there is no
 * silent fallback here, matching the chess-engine's no-fallback rule.
 */
export class AssetManager<TImage> {
  private state: AssetLoadState = 'loading';
  private error?: AppError;
  private images: PieceImages<TImage> | null = null;

  constructor(
    private readonly manifest: PieceManifest,
    private readonly loadImage: (url: string) => Promise<TImage>
  ) {}

  getState(): AssetLoadState {
    return this.state;
  }

  getError(): AppError | undefined {
    return this.error;
  }

  async load(): Promise<Result<void, AppError>> {
    try {
      const colors = Object.keys(this.manifest) as Color[];
      const loaded = {} as PieceImages<TImage>;
      for (const color of colors) {
        const byType = this.manifest[color];
        const types = Object.keys(byType) as PieceType[];
        const entries = await Promise.all(
          types.map(async (type) => [type, await this.loadImage(byType[type])] as const)
        );
        loaded[color] = Object.fromEntries(entries) as Record<PieceType, TImage>;
      }
      this.images = loaded;
      this.state = 'ready';
      return ok(undefined);
    } catch (cause) {
      this.state = 'error';
      this.error = assetLoadError(cause);
      return err(this.error);
    }
  }

  getPieceImage(color: Color, type: PieceType): TImage | null {
    if (this.state !== 'ready' || !this.images) return null;
    return this.images[color][type];
  }
}
