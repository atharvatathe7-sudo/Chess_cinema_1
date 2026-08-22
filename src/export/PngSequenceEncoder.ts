import { StreamingZipWriter } from './zip';
import type { Encoder, EncoderMeta } from './Encoder';

export interface WritableFileStreamLike {
  write(data: BufferSource | Blob | string): Promise<void>;
  close(): Promise<void>;
}

export interface DirectoryHandleLike {
  getFileHandle(name: string, opts?: { create?: boolean }): Promise<{ createWritable(): Promise<WritableFileStreamLike> }>;
}

function frameName(index: number): string {
  return `frame-${String(index).padStart(5, '0')}.png`;
}

/**
 * Phase 1's only export encoder: a deterministic PNG sequence. Two
 * modes, chosen by the caller based on export/capabilities.ts:
 *
 * - With a directory handle (File System Access API): each frame is
 *   written straight to disk as its own PNG file. True O(1) memory
 *   regardless of export length — nothing but the current frame's bytes
 *   is ever in memory.
 * - Without one: frames are streamed into an in-memory ZIP archive
 *   (StreamingZipWriter) so the result is a single downloadable file.
 *   Peak memory here is one frame's PNG bytes plus the archive's
 *   already-encoded output so far — never a second copy, and never raw
 *   decoded pixel buffers for more than the current frame (Correction 4).
 *
 * Never silently picks one over the other — the caller decides based on
 * a surfaced capability check, not a hidden fallback.
 */
export class PngSequenceEncoder implements Encoder {
  private readonly zip: StreamingZipWriter | null;
  private readonly directory: DirectoryHandleLike | null;

  constructor(directory: DirectoryHandleLike | null = null) {
    this.directory = directory;
    this.zip = directory ? null : new StreamingZipWriter();
  }

  start(_meta: EncoderMeta): void {
    // No container header to write for a PNG sequence; kept for Encoder
    // interface symmetry with future encoders that need one.
  }

  async addFrame(canvas: OffscreenCanvas, frameIndex: number): Promise<void> {
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const name = frameName(frameIndex);

    if (this.directory) {
      const fileHandle = await this.directory.getFileHandle(name, { create: true });
      const writable = await fileHandle.createWritable();
      await writable.write(bytes);
      await writable.close();
      return;
    }

    this.zip!.addEntry(name, bytes);
  }

  async finish(): Promise<Blob | null> {
    if (this.directory) return null;
    return this.zip!.finish();
  }
}
