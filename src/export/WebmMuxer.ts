/**
 * Minimal WebM/EBML muxer — Phase 5's counterpart to zip.ts: a small,
 * self-contained, hand-written container writer rather than a dependency,
 * matching this project's existing "own the primitive" style. Writes
 * exactly what a single-track VP9 video needs: the EBML header, a Segment
 * with Info (TimecodeScale + Duration) and Tracks (one video TrackEntry),
 * and one or more Clusters of SimpleBlocks carrying already-encoded VP9
 * frame bytes. No audio, no seeking Cues, no multi-track support — none
 * of that is needed for a single deterministic cinematic export.
 *
 * This module never touches WebCodecs or canvas APIs — it only assembles
 * bytes it is handed, which is what makes it fully unit-testable under
 * Node (see WebmMuxer.test.ts), the same split this project already uses
 * for render/ (pixel work, Playwright-only) vs. export/zip.ts (byte work,
 * Vitest-only).
 */

/** 1 tick = 1ms, chosen to match FrameSource's millisecond time domain exactly — no unit conversion anywhere else in this module. */
const TIMECODE_SCALE_NS = 1_000_000;

/** Matroska SimpleBlock timecodes are signed 16-bit relative to their Cluster's own Timecode; a new Cluster starts well before this could ever be threatened. */
const MAX_CLUSTER_SPAN_MS = 30_000;

const ID = {
  EBML: [0x1a, 0x45, 0xdf, 0xa3],
  EBMLVersion: [0x42, 0x86],
  EBMLReadVersion: [0x42, 0xf7],
  EBMLMaxIDLength: [0x42, 0xf2],
  EBMLMaxSizeLength: [0x42, 0xf3],
  DocType: [0x42, 0x82],
  DocTypeVersion: [0x42, 0x87],
  DocTypeReadVersion: [0x42, 0x85],
  Segment: [0x18, 0x53, 0x80, 0x67],
  Info: [0x15, 0x49, 0xa9, 0x66],
  TimecodeScale: [0x2a, 0xd7, 0xb1],
  Duration: [0x44, 0x89],
  MuxingApp: [0x4d, 0x80],
  WritingApp: [0x57, 0x41],
  Tracks: [0x16, 0x54, 0xae, 0x6b],
  TrackEntry: [0xae],
  TrackNumber: [0xd7],
  TrackUID: [0x73, 0xc5],
  TrackType: [0x83],
  CodecID: [0x86],
  Video: [0xe0],
  PixelWidth: [0xb0],
  PixelHeight: [0xba],
  Cluster: [0x1f, 0x43, 0xb6, 0x75],
  Timecode: [0xe7],
  SimpleBlock: [0xa3]
} as const;

const VIDEO_TRACK_NUMBER = 1;
const VIDEO_TRACK_TYPE = 1; // Matroska TrackType: 1 = video
const VIDEO_TRACK_UID = 1;

/** Minimal-length EBML variable-size integer (the "VINT" element-size encoding) — the marker bit's position encodes the byte length. */
function encodeVint(value: number): Uint8Array {
  let length = 1;
  while (value > Math.pow(2, 7 * length) - 1) length++;
  if (length > 8) throw new Error(`WebmMuxer: value ${value} exceeds the largest representable EBML vint`);
  const bytes = new Uint8Array(length);
  let remaining = value;
  for (let i = length - 1; i >= 0; i--) {
    bytes[i] = remaining & 0xff;
    remaining = Math.floor(remaining / 256);
  }
  bytes[0]! |= 1 << (8 - length);
  return bytes;
}

/** Big-endian unsigned integer using the minimum number of bytes — the convention Matroska uses for uint-typed elements (TrackNumber, PixelWidth, etc). */
function encodeUintMinimal(value: number): Uint8Array {
  if (value === 0) return new Uint8Array([0]);
  const bytes: number[] = [];
  let remaining = value;
  while (remaining > 0) {
    bytes.unshift(remaining & 0xff);
    remaining = Math.floor(remaining / 256);
  }
  return new Uint8Array(bytes);
}

function encodeFloat64(value: number): Uint8Array {
  const buffer = new ArrayBuffer(8);
  new DataView(buffer).setFloat64(0, value, false);
  return new Uint8Array(buffer);
}

/** Signed 16-bit big-endian — the SimpleBlock relative-timecode field. */
function encodeInt16(value: number): Uint8Array {
  if (value < -32768 || value > 32767) {
    throw new Error(`WebmMuxer: relative timecode ${value} does not fit in a Matroska SimpleBlock's signed 16-bit field`);
  }
  const buffer = new ArrayBuffer(2);
  new DataView(buffer).setInt16(0, value, false);
  return new Uint8Array(buffer);
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/** Wraps element content with its id and a vint-encoded size — the one operation every EBML element (master or leaf) needs. */
function element(id: readonly number[], content: Uint8Array): Uint8Array {
  return concat([new Uint8Array(id), encodeVint(content.length), content]);
}

function stringBytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

export interface WebmVideoTrackMeta {
  readonly width: number;
  readonly height: number;
  /** Matroska CodecID string, e.g. 'V_VP9'. */
  readonly codecId: string;
}

export interface WebmEncodedFrame {
  readonly data: Uint8Array;
  readonly timestampMs: number;
  readonly isKeyframe: boolean;
}

/**
 * Buffers already-encoded VP9 chunks (never raw canvas/pixel data — see
 * the module doc comment) and assembles them into a single playable
 * .webm Blob on finish(). Frames must be added in non-decreasing
 * timestamp order; a new Cluster is started automatically whenever a
 * keyframe arrives (after the first) or the running span would exceed
 * MAX_CLUSTER_SPAN_MS, keeping every Cluster's relative timecodes small
 * and every Cluster's first block a keyframe — both real Matroska
 * conventions, not arbitrary choices.
 */
export class WebmMuxer {
  private track: WebmVideoTrackMeta | null = null;
  private readonly frames: WebmEncodedFrame[] = [];

  start(track: WebmVideoTrackMeta): void {
    if (this.track) throw new Error('WebmMuxer.start called more than once');
    this.track = track;
  }

  addEncodedFrame(frame: WebmEncodedFrame): void {
    if (!this.track) throw new Error('WebmMuxer.addEncodedFrame called before start()');
    const last = this.frames[this.frames.length - 1];
    if (last && frame.timestampMs < last.timestampMs) {
      throw new Error('WebmMuxer.addEncodedFrame: frames must be added in non-decreasing timestamp order');
    }
    this.frames.push(frame);
  }

  finish(): Blob {
    if (!this.track) throw new Error('WebmMuxer.finish called before start()');
    if (this.frames.length === 0) throw new Error('WebmMuxer.finish called with no frames — nothing to export');
    if (!this.frames[0]!.isKeyframe) throw new Error('WebmMuxer.finish: the first frame must be a keyframe');

    const header = this.buildEbmlHeader();
    const segment = this.buildSegment(this.track, this.frames);
    return new Blob([concat([header, segment]) as BlobPart], { type: 'video/webm' });
  }

  private buildEbmlHeader(): Uint8Array {
    return element(ID.EBML, concat([
      element(ID.EBMLVersion, encodeUintMinimal(1)),
      element(ID.EBMLReadVersion, encodeUintMinimal(1)),
      element(ID.EBMLMaxIDLength, encodeUintMinimal(4)),
      element(ID.EBMLMaxSizeLength, encodeUintMinimal(8)),
      element(ID.DocType, stringBytes('webm')),
      element(ID.DocTypeVersion, encodeUintMinimal(2)),
      element(ID.DocTypeReadVersion, encodeUintMinimal(2))
    ]));
  }

  private buildSegment(track: WebmVideoTrackMeta, frames: readonly WebmEncodedFrame[]): Uint8Array {
    const lastFrame = frames[frames.length - 1]!;
    const durationTicks = tickMs(lastFrame) + this.estimateFinalFrameDurationMs(frames);

    const info = element(ID.Info, concat([
      element(ID.TimecodeScale, encodeUintMinimal(TIMECODE_SCALE_NS)),
      element(ID.Duration, encodeFloat64(durationTicks)),
      element(ID.MuxingApp, stringBytes('chess-cinema')),
      element(ID.WritingApp, stringBytes('chess-cinema'))
    ]));

    const tracks = element(ID.Tracks, element(ID.TrackEntry, concat([
      element(ID.TrackNumber, encodeUintMinimal(VIDEO_TRACK_NUMBER)),
      element(ID.TrackUID, encodeUintMinimal(VIDEO_TRACK_UID)),
      element(ID.TrackType, encodeUintMinimal(VIDEO_TRACK_TYPE)),
      element(ID.CodecID, stringBytes(track.codecId)),
      element(ID.Video, concat([
        element(ID.PixelWidth, encodeUintMinimal(track.width)),
        element(ID.PixelHeight, encodeUintMinimal(track.height))
      ]))
    ])));

    const clusters = concat(this.groupIntoClusters(frames).map((cluster) => this.buildCluster(cluster)));

    return element(ID.Segment, concat([info, tracks, clusters]));
  }

  /** A new cluster starts on every keyframe after the first, or once the span since the current cluster's start would risk the int16 relative-timecode limit — whichever comes first. */
  private groupIntoClusters(frames: readonly WebmEncodedFrame[]): WebmEncodedFrame[][] {
    const clusters: WebmEncodedFrame[][] = [];
    let current: WebmEncodedFrame[] = [];
    for (const frame of frames) {
      const clusterStartMs = current[0] ? tickMs(current[0]) : undefined;
      const startsNewCluster = current.length > 0 && (frame.isKeyframe || tickMs(frame) - clusterStartMs! >= MAX_CLUSTER_SPAN_MS);
      if (startsNewCluster) {
        clusters.push(current);
        current = [];
      }
      current.push(frame);
    }
    if (current.length > 0) clusters.push(current);
    return clusters;
  }

  private buildCluster(frames: readonly WebmEncodedFrame[]): Uint8Array {
    const clusterTimecodeMs = tickMs(frames[0]!);
    const blocks = frames.map((frame) => this.buildSimpleBlock(frame, clusterTimecodeMs));
    return element(ID.Cluster, concat([
      element(ID.Timecode, encodeUintMinimal(clusterTimecodeMs)),
      ...blocks
    ]));
  }

  private buildSimpleBlock(frame: WebmEncodedFrame, clusterTimecodeMs: number): Uint8Array {
    const relativeTimecode = tickMs(frame) - clusterTimecodeMs;
    const flags = new Uint8Array([frame.isKeyframe ? 0x80 : 0x00]);
    const content = concat([encodeVint(VIDEO_TRACK_NUMBER), encodeInt16(relativeTimecode), flags, frame.data]);
    return element(ID.SimpleBlock, content);
  }

  /** SimpleBlock carries no per-frame duration; the last frame's own display length is inferred here from the gap to the previous frame (falls back to 0 for a single-frame video, which is still a structurally valid, if degenerate, file). */
  private estimateFinalFrameDurationMs(frames: readonly WebmEncodedFrame[]): number {
    if (frames.length < 2) return 0;
    return tickMs(frames[frames.length - 1]!) - tickMs(frames[frames.length - 2]!);
  }
}

/** Matroska timecodes are integer ticks; this is the single place sub-millisecond precision from an upstream microsecond timestamp gets truncated away, applied consistently everywhere a frame's timestamp becomes container bytes. */
function tickMs(frame: WebmEncodedFrame): number {
  return Math.trunc(frame.timestampMs);
}
