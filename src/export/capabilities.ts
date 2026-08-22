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
