export interface EncoderMeta {
  width: number;
  height: number;
  fps: number;
}

export interface Encoder {
  start(meta: EncoderMeta): void | Promise<void>;
  /**
   * Consumes exactly one already-rendered frame. Must resolve before
   * the caller renders the next frame (runExport awaits this), which is
   * what bounds memory to one frame in flight at a time — see
   * docs/architecture.md Correction 4.
   */
  addFrame(canvas: OffscreenCanvas, frameIndex: number): Promise<void>;
  /** Returns the finished archive, or null if frames were already written directly to disk. */
  finish(): Promise<Blob | null>;
}
