import { describe, expect, it } from 'vitest';
import { WebmMuxer, type WebmEncodedFrame } from './WebmMuxer';

/**
 * Minimal EBML reader, used only to verify our own muxer's output —
 * exactly the same "hand-roll a reader to check our own hand-rolled
 * writer" approach zip.test.ts already uses for StreamingZipWriter.
 */
interface EbmlElement {
  id: number;
  content: Uint8Array;
}

function vintLength(firstByte: number): number {
  for (let length = 1; length <= 8; length++) {
    if (firstByte & (0x80 >> (length - 1))) return length;
  }
  throw new Error('invalid EBML vint length byte');
}

function readElementId(bytes: Uint8Array, offset: number): { id: number; length: number } {
  const length = vintLength(bytes[offset]!);
  let id = 0;
  for (let i = 0; i < length; i++) id = id * 256 + bytes[offset + i]!;
  return { id, length };
}

function readElementSize(bytes: Uint8Array, offset: number): { size: number; length: number } {
  const length = vintLength(bytes[offset]!);
  const marker = 0x80 >> (length - 1);
  let value = bytes[offset]! & (marker - 1);
  for (let i = 1; i < length; i++) value = value * 256 + bytes[offset + i]!;
  return { size: value, length };
}

function readElements(bytes: Uint8Array, start: number, end: number): EbmlElement[] {
  const out: EbmlElement[] = [];
  let offset = start;
  while (offset < end) {
    const { id, length: idLen } = readElementId(bytes, offset);
    offset += idLen;
    const { size, length: sizeLen } = readElementSize(bytes, offset);
    offset += sizeLen;
    out.push({ id, content: bytes.subarray(offset, offset + size) });
    offset += size;
  }
  return out;
}

function findAll(elements: readonly EbmlElement[], id: number): EbmlElement[] {
  return elements.filter((e) => e.id === id);
}
function find(elements: readonly EbmlElement[], id: number): EbmlElement {
  const el = elements.find((e) => e.id === id);
  if (!el) throw new Error(`element 0x${id.toString(16)} not found`);
  return el;
}

function readUint(bytes: Uint8Array): number {
  let v = 0;
  for (const b of bytes) v = v * 256 + b;
  return v;
}
function readFloat64(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return view.getFloat64(0, false);
}
function readInt16(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return view.getInt16(0, false);
}
function readString(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

// Known Matroska/EBML element IDs, kept independent of WebmMuxer's own
// internal constants so a bug in one can't hide behind the other.
const ID = {
  EBML: 0x1a45dfa3,
  Segment: 0x18538067,
  Info: 0x1549a966,
  TimecodeScale: 0x2ad7b1,
  Duration: 0x4489,
  Tracks: 0x1654ae6b,
  TrackEntry: 0xae,
  TrackNumber: 0xd7,
  TrackType: 0x83,
  CodecID: 0x86,
  Video: 0xe0,
  PixelWidth: 0xb0,
  PixelHeight: 0xba,
  Cluster: 0x1f43b675,
  Timecode: 0xe7,
  SimpleBlock: 0xa3
};

async function parseWebm(blob: Blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const top = readElements(bytes, 0, bytes.length);
  const ebml = find(top, ID.EBML);
  const segment = find(top, ID.Segment);
  const segmentChildren = readElements(segment.content, 0, segment.content.length);
  const info = readElements(find(segmentChildren, ID.Info).content, 0, find(segmentChildren, ID.Info).content.length);
  const tracks = readElements(find(segmentChildren, ID.Tracks).content, 0, find(segmentChildren, ID.Tracks).content.length);
  const trackEntry = readElements(find(tracks, ID.TrackEntry).content, 0, find(tracks, ID.TrackEntry).content.length);
  const video = readElements(find(trackEntry, ID.Video).content, 0, find(trackEntry, ID.Video).content.length);

  const clusters = findAll(segmentChildren, ID.Cluster).map((cluster) => {
    const children = readElements(cluster.content, 0, cluster.content.length);
    const timecode = readUint(find(children, ID.Timecode).content);
    const blocks = findAll(children, ID.SimpleBlock).map((block) => {
      // SimpleBlock content: track-number vint(1 byte here), int16 relative timecode, 1 flags byte, then payload.
      const trackNumber = block.content[0]!;
      const relativeTimecode = readInt16(block.content.subarray(1, 3));
      const flags = block.content[3]!;
      const payload = block.content.subarray(4);
      return { trackNumber, absoluteTimecodeMs: timecode + relativeTimecode, isKeyframe: (flags & 0x80) !== 0, payload };
    });
    return { timecode, blocks };
  });

  return {
    ebmlPresent: !!ebml,
    timecodeScale: readUint(find(info, ID.TimecodeScale).content),
    durationMs: readFloat64(find(info, ID.Duration).content),
    codecId: readString(find(trackEntry, ID.CodecID).content),
    trackType: readUint(find(trackEntry, ID.TrackType).content),
    trackNumber: readUint(find(trackEntry, ID.TrackNumber).content),
    pixelWidth: readUint(find(video, ID.PixelWidth).content),
    pixelHeight: readUint(find(video, ID.PixelHeight).content),
    clusters,
    allBlocks: clusters.flatMap((c) => c.blocks)
  };
}

function frame(timestampMs: number, isKeyframe: boolean, payload = new Uint8Array([1, 2, 3])): WebmEncodedFrame {
  return { data: payload, timestampMs, isKeyframe };
}

describe('WebmMuxer', () => {
  it('1. produces a top-level EBML header followed by a Segment', async () => {
    const muxer = new WebmMuxer();
    muxer.start({ width: 80, height: 60, codecId: 'V_VP9' });
    muxer.addEncodedFrame(frame(0, true));
    const parsed = await parseWebm(muxer.finish());
    expect(parsed.ebmlPresent).toBe(true);
  });

  it('2. writes correct VP9 track metadata (CodecID, TrackType=video, TrackNumber)', async () => {
    const muxer = new WebmMuxer();
    muxer.start({ width: 80, height: 60, codecId: 'V_VP9' });
    muxer.addEncodedFrame(frame(0, true));
    const parsed = await parseWebm(muxer.finish());
    expect(parsed.codecId).toBe('V_VP9');
    expect(parsed.trackType).toBe(1);
    expect(parsed.trackNumber).toBe(1);
  });

  it('3. writes the exact configured pixel dimensions', async () => {
    const muxer = new WebmMuxer();
    muxer.start({ width: 800, height: 600, codecId: 'V_VP9' });
    muxer.addEncodedFrame(frame(0, true));
    const parsed = await parseWebm(muxer.finish());
    expect(parsed.pixelWidth).toBe(800);
    expect(parsed.pixelHeight).toBe(600);
  });

  it('4. reconstructs correct absolute timestamps from Cluster Timecode + SimpleBlock relative offsets', async () => {
    const muxer = new WebmMuxer();
    muxer.start({ width: 80, height: 60, codecId: 'V_VP9' });
    const timestamps = [0, 41.67, 83.33, 125, 166.67];
    for (const [i, ts] of timestamps.entries()) muxer.addEncodedFrame(frame(ts, i === 0));
    const parsed = await parseWebm(muxer.finish());
    expect(parsed.allBlocks.map((b) => b.absoluteTimecodeMs)).toEqual(timestamps.map((t) => Math.trunc(t)));
    // Matroska block timecodes are integer; sub-ms precision is intentionally not representable — see WebmMuxer's Int16 encoder.
  });

  it('5. frame count matches the number of addEncodedFrame calls', async () => {
    const muxer = new WebmMuxer();
    muxer.start({ width: 80, height: 60, codecId: 'V_VP9' });
    for (let i = 0; i < 12; i++) muxer.addEncodedFrame(frame(i * 40, i % 6 === 0));
    const parsed = await parseWebm(muxer.finish());
    expect(parsed.allBlocks.length).toBe(12);
  });

  it('6. deterministic container/timing output for identical synthetic input (byte-identical, since the muxer itself has no randomness or wall-clock dependency — this says nothing about VideoEncoder\'s own encoded-byte determinism, which this test does not exercise)', async () => {
    const build = async () => {
      const muxer = new WebmMuxer();
      muxer.start({ width: 80, height: 60, codecId: 'V_VP9' });
      muxer.addEncodedFrame(frame(0, true, new Uint8Array([9, 8, 7])));
      muxer.addEncodedFrame(frame(42, false, new Uint8Array([6, 5, 4])));
      return new Uint8Array(await muxer.finish().arrayBuffer());
    };
    const first = await build();
    const second = await build();
    expect(first).toEqual(second);
  });

  it('7a. start/addFrame/finish happy-path lifecycle produces a non-empty, playable-shaped blob', async () => {
    const muxer = new WebmMuxer();
    muxer.start({ width: 80, height: 60, codecId: 'V_VP9' });
    muxer.addEncodedFrame(frame(0, true));
    muxer.addEncodedFrame(frame(42, false));
    const blob = muxer.finish();
    expect(blob.size).toBeGreaterThan(0);
    expect(blob.type).toBe('video/webm');
  });

  it('7b. addEncodedFrame before start() throws a clear error', () => {
    const muxer = new WebmMuxer();
    expect(() => muxer.addEncodedFrame(frame(0, true))).toThrow(/before start/);
  });

  it('7c. finish() before start() throws a clear error', () => {
    const muxer = new WebmMuxer();
    expect(() => muxer.finish()).toThrow(/before start/);
  });

  it('7d. start() called twice throws a clear error', () => {
    const muxer = new WebmMuxer();
    muxer.start({ width: 80, height: 60, codecId: 'V_VP9' });
    expect(() => muxer.start({ width: 80, height: 60, codecId: 'V_VP9' })).toThrow(/more than once/);
  });

  it('8a. finish() with zero frames throws a clear error rather than producing an empty/corrupt file', () => {
    const muxer = new WebmMuxer();
    muxer.start({ width: 80, height: 60, codecId: 'V_VP9' });
    expect(() => muxer.finish()).toThrow(/no frames/i);
  });

  it('8b. the first frame not being a keyframe throws a clear error', () => {
    const muxer = new WebmMuxer();
    muxer.start({ width: 80, height: 60, codecId: 'V_VP9' });
    muxer.addEncodedFrame(frame(0, false));
    expect(() => muxer.finish()).toThrow(/first frame must be a keyframe/);
  });

  it('8c. frames added out of non-decreasing timestamp order throw a clear error', () => {
    const muxer = new WebmMuxer();
    muxer.start({ width: 80, height: 60, codecId: 'V_VP9' });
    muxer.addEncodedFrame(frame(100, true));
    expect(() => muxer.addEncodedFrame(frame(50, false))).toThrow(/non-decreasing/);
  });

  it('9. starts a new Cluster on every keyframe after the first, keeping every Cluster\'s first block a keyframe', async () => {
    const muxer = new WebmMuxer();
    muxer.start({ width: 80, height: 60, codecId: 'V_VP9' });
    // Simulates a real keyframe-every-N-frames pattern (Vp9VideoEncoder uses ~2s intervals).
    const isKey = (i: number) => i % 4 === 0;
    for (let i = 0; i < 10; i++) muxer.addEncodedFrame(frame(i * 100, isKey(i)));
    const parsed = await parseWebm(muxer.finish());
    expect(parsed.clusters.length).toBe(3); // keyframes at i=0,4,8 => 3 clusters
    for (const cluster of parsed.clusters) {
      expect(cluster.blocks[0]!.isKeyframe).toBe(true);
    }
    expect(parsed.allBlocks.length).toBe(10);
  });

  it('10. a large gap between frames automatically starts a new Cluster rather than risking an int16 relative-timecode overflow', async () => {
    const muxer = new WebmMuxer();
    muxer.start({ width: 80, height: 60, codecId: 'V_VP9' });
    muxer.addEncodedFrame(frame(0, true));
    // Non-keyframe, but far enough past the first cluster's start (>= MAX_CLUSTER_SPAN_MS) to force its own new cluster automatically.
    muxer.addEncodedFrame(frame(40000, false));
    const parsed = await parseWebm(muxer.finish());
    expect(parsed.clusters.length).toBe(2);
    expect(parsed.clusters[1]!.timecode).toBe(40000);
    expect(parsed.allBlocks[1]!.absoluteTimecodeMs).toBe(40000);
  });

  it('preserves total video duration close to the last frame plus one inferred frame interval', async () => {
    const muxer = new WebmMuxer();
    muxer.start({ width: 80, height: 60, codecId: 'V_VP9' });
    const fps24FrameMs = 1000 / 24;
    for (let i = 0; i < 5; i++) muxer.addEncodedFrame(frame(Math.round(i * fps24FrameMs), i === 0));
    const parsed = await parseWebm(muxer.finish());
    const expectedDuration = Math.round(4 * fps24FrameMs) + Math.round(fps24FrameMs);
    expect(parsed.durationMs).toBeCloseTo(expectedDuration, 0);
  });
});
