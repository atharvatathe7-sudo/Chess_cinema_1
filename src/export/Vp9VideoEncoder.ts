import type { Encoder, EncoderMeta } from './Encoder';
import { frameIndexToTimeMs } from './FrameSource';
import { WebmMuxer } from './WebmMuxer';

/**
 * VP9 Profile 0, level 1.0, 8-bit — confirmed via a live capability probe
 * to be accepted by VideoEncoder.isConfigSupported (and to actually
 * encode successfully) across every export dimension this app produces
 * (board sizes up to 1440x1440 at high DPR); Chromium does not reject the
 * level component against larger frame sizes in practice, so a single
 * fixed codec string is sufficient — no per-export negotiation is needed.
 */
export const VP9_CODEC = 'vp09.00.10.08';

const CODEC_ID = 'V_VP9';

/** A keyframe roughly every 2 seconds keeps every WebmMuxer Cluster's relative timecodes small and gives the container real seek points, without meaningfully hurting compression for board-sized content. */
function keyframeIntervalFrames(fps: number): number {
  return Math.max(1, Math.round(fps * 2));
}

/** A simple, fixed heuristic — not user-configurable in this phase (see the Phase 5 scope: no format/quality selector yet). Board content is mostly flat color with modest per-frame motion, so this comfortably avoids visible blocking at the sizes this app renders. */
export function estimateVp9Bitrate(width: number, height: number, fps: number): number {
  const raw = width * height * fps * 0.05;
  return Math.round(Math.min(8_000_000, Math.max(500_000, raw)));
}

function toError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}

/**
 * Encoder implementation for "Export Video": renders through the exact
 * same runExport loop as PngSequenceEncoder (one OffscreenCanvas frame at
 * a time, awaited before the next is rendered — see runExport.ts), but
 * feeds each frame into a WebCodecs VideoEncoder instead of PNG-encoding
 * it, and hands the resulting VP9 chunks to WebmMuxer. No PNG encoding or
 * decoding occurs anywhere in this path.
 *
 * Frame timestamps are computed the same way PngSequenceEncoder's frame
 * ordering is implied — via FrameSource.frameIndexToTimeMs — never from
 * wall-clock time, preserving the export pipeline's determinism guarantee.
 */
export class Vp9VideoEncoder implements Encoder {
  private videoEncoder: VideoEncoder | null = null;
  private readonly muxer = new WebmMuxer();
  private fps = 0;
  private pendingError: Error | null = null;

  async start(meta: EncoderMeta): Promise<void> {
    if (typeof VideoEncoder === 'undefined') {
      throw new Error('WebCodecs VideoEncoder is not available in this browser — video export is unsupported here.');
    }

    this.fps = meta.fps;
    this.muxer.start({ width: meta.width, height: meta.height, codecId: CODEC_ID });

    this.videoEncoder = new VideoEncoder({
      output: (chunk) => {
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        this.muxer.addEncodedFrame({
          data,
          timestampMs: chunk.timestamp / 1000, // WebCodecs timestamps are microseconds; FrameSource's domain is milliseconds.
          isKeyframe: chunk.type === 'key'
        });
      },
      error: (cause) => {
        this.pendingError = toError(cause);
      }
    });

    try {
      this.videoEncoder.configure({
        codec: VP9_CODEC,
        width: meta.width,
        height: meta.height,
        bitrate: estimateVp9Bitrate(meta.width, meta.height, meta.fps),
        framerate: meta.fps,
        latencyMode: 'quality'
      });
    } catch (cause) {
      this.videoEncoder = null;
      throw new Error(`Vp9VideoEncoder: failed to configure a VP9 VideoEncoder — ${toError(cause).message}`);
    }
  }

  async addFrame(canvas: OffscreenCanvas, frameIndex: number): Promise<void> {
    if (!this.videoEncoder) throw new Error('Vp9VideoEncoder.addFrame called before start()');
    this.throwIfErrored();
    await this.waitForQueueCapacity();

    const timestampMs = frameIndexToTimeMs(frameIndex, this.fps);
    const frame = new VideoFrame(canvas, {
      timestamp: Math.round(timestampMs * 1000),
      duration: Math.round((1000 / this.fps) * 1000)
    });
    try {
      this.videoEncoder.encode(frame, { keyFrame: frameIndex % keyframeIntervalFrames(this.fps) === 0 });
    } finally {
      frame.close();
    }
    this.throwIfErrored();
  }

  async finish(): Promise<Blob> {
    if (!this.videoEncoder) throw new Error('Vp9VideoEncoder.finish called before start()');
    const encoder = this.videoEncoder;
    try {
      await encoder.flush();
    } catch (cause) {
      throw new Error(`Vp9VideoEncoder: encoder.flush() failed — ${toError(cause).message}`);
    } finally {
      encoder.close();
      this.videoEncoder = null;
    }
    this.throwIfErrored();
    return this.muxer.finish();
  }

  private throwIfErrored(): void {
    if (this.pendingError) {
      const err = this.pendingError;
      this.pendingError = null;
      throw err;
    }
  }

  /** Bounds how far the browser's internal encode queue can grow ahead of us — the WebCodecs analogue of runExport's "await addFrame before rendering the next frame" invariant, since encode() itself returns synchronously while the actual work happens asynchronously off the queue. */
  private async waitForQueueCapacity(): Promise<void> {
    const QUEUE_CAPACITY = 2;
    const encoder = this.videoEncoder;
    if (!encoder) return;
    while (encoder.encodeQueueSize > QUEUE_CAPACITY) {
      await new Promise<void>((resolve) => {
        encoder.addEventListener('dequeue', () => resolve(), { once: true });
      });
    }
  }
}
