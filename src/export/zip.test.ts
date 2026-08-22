import { describe, expect, it } from 'vitest';
import { StreamingZipWriter } from './zip';
import { crc32 } from './crc32';

/** Minimal STORE-only zip reader, used only to verify our own writer's output. */
function readZipEntries(bytes: Uint8Array): Map<string, Uint8Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // Find End Of Central Directory (fixed 22 bytes, no comment in our writer).
  const eocdOffset = bytes.length - 22;
  expect(view.getUint32(eocdOffset, true)).toBe(0x06054b50);
  const entryCount = view.getUint16(eocdOffset + 10, true);
  const centralDirOffset = view.getUint32(eocdOffset + 16, true);

  const entries = new Map<string, Uint8Array>();
  let cursor = centralDirOffset;
  for (let i = 0; i < entryCount; i++) {
    expect(view.getUint32(cursor, true)).toBe(0x02014b50);
    const crc = view.getUint32(cursor + 16, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const localHeaderOffset = view.getUint32(cursor + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength));

    // Local header: 30 bytes fixed + filename + extra, then raw data.
    const localNameLength = view.getUint16(localHeaderOffset + 26, true);
    const localExtraLength = view.getUint16(localHeaderOffset + 28, true);
    const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength;
    const data = bytes.subarray(dataStart, dataStart + compressedSize);
    expect(crc32(data)).toBe(crc);

    entries.set(name, data);
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

describe('StreamingZipWriter', () => {
  it('round-trips a single entry', async () => {
    const writer = new StreamingZipWriter();
    writer.addEntry('frame-000.png', new TextEncoder().encode('hello world'));
    const blob = writer.finish();
    const bytes = new Uint8Array(await blob.arrayBuffer());

    const entries = readZipEntries(bytes);
    expect(entries.size).toBe(1);
    expect(new TextDecoder().decode(entries.get('frame-000.png'))).toBe('hello world');
  });

  it('round-trips multiple entries added incrementally, preserving order and content', async () => {
    const writer = new StreamingZipWriter();
    const payloads = ['frame one', 'frame two', 'frame three'];
    payloads.forEach((p, i) => writer.addEntry(`frame-${i}.bin`, new TextEncoder().encode(p)));
    const blob = writer.finish();
    const bytes = new Uint8Array(await blob.arrayBuffer());

    const entries = readZipEntries(bytes);
    expect(entries.size).toBe(3);
    payloads.forEach((p, i) => {
      expect(new TextDecoder().decode(entries.get(`frame-${i}.bin`))).toBe(p);
    });
  });

  it('handles binary (non-UTF8) data correctly', async () => {
    const writer = new StreamingZipWriter();
    const binary = new Uint8Array([0, 1, 2, 255, 254, 253, 137, 80, 78, 71]);
    writer.addEntry('frame.png', binary);
    const bytes = new Uint8Array(await writer.finish().arrayBuffer());

    const entries = readZipEntries(bytes);
    expect(entries.get('frame.png')).toEqual(binary);
  });
});
