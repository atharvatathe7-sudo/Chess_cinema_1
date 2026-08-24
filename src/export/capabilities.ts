import { VP9_CODEC, estimateVp9Bitrate } from './Vp9VideoEncoder';

/**
 * Explicit, surfaced feature detection. Nothing in export/ silently
 * assumes a capability is present and falls back unannounced — see
 * docs/architecture.md Correction 4 / §14.
 */
export interface ExportCapabilities {
  offscreenCanvas: boolean;
  /** File System Access API — enables true O(1)-memory streaming-to-disk. Not assumed on Chrome Android. */
  fileSystemAccess: boolean;
}

export function detectExportCapabilities(scope: typeof globalThis = globalThis): ExportCapabilities {
  return {
    offscreenCanvas: typeof scope.OffscreenCanvas === 'function',
    fileSystemAccess: typeof (scope as { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function'
  };
}

export interface Vp9VideoExportSupport {
  supported: boolean;
  /** Present only when supported is false — a short, user-facing explanation of why "Export Video" is unavailable. */
  reason?: string;
}

/**
 * Async (unlike the two checks above) because the only real way to know
 * whether this browser's VP9 encoder actually accepts our export
 * dimensions is to ask it — VideoEncoder.isConfigSupported. Never assumed
 * from a browser/UA sniff. Same explicit, surfaced-not-silent convention
 * as detectExportCapabilities: callers get a typed answer (plus a reason
 * when unsupported) rather than a hidden fallback.
 */
export async function detectVp9VideoExportSupport(
  dims: { width: number; height: number },
  fps: number,
  scope: typeof globalThis = globalThis
): Promise<Vp9VideoExportSupport> {
  const videoEncoderCtor = (scope as { VideoEncoder?: typeof VideoEncoder }).VideoEncoder;
  if (typeof videoEncoderCtor === 'undefined') {
    return { supported: false, reason: 'This browser does not support WebCodecs video encoding (VideoEncoder is unavailable).' };
  }
  try {
    const result = await videoEncoderCtor.isConfigSupported({
      codec: VP9_CODEC,
      width: dims.width,
      height: dims.height,
      bitrate: estimateVp9Bitrate(dims.width, dims.height, fps),
      framerate: fps
    });
    return result.supported
      ? { supported: true }
      : { supported: false, reason: 'This browser reports no support for VP9 video encoding at the current export size.' };
  } catch (cause) {
    return { supported: false, reason: `VP9 support check failed: ${cause instanceof Error ? cause.message : String(cause)}` };
  }
}
