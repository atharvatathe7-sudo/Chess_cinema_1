import { crc32 } from './crc32';

/**
 * Minimal streaming ZIP writer, STORE method only (no compression — PNG
 * bytes are already compressed, so no compression library is needed;
 * see docs/architecture.md Correction 4). Each addEntry() call appends
 * a local file header + raw bytes to a running list of chunks and
 * records a matching central-directory entry; finish() assembles the
 * final archive. This does not hold decoded pixel data — only already-
 * PNG-encoded bytes, one entry's worth added at a time.
 */
export class StreamingZipWriter {
  private chunks: Uint8Array[] = [];
  private centralDirectory: Uint8Array[] = [];
  private offset = 0;
  private entryCount = 0;

  addEntry(name: string, data: Uint8Array): void {
    const nameBytes = new TextEncoder().encode(name);
    const crc = crc32(data);
    // Fixed (not wall-clock) timestamp: export output must be a pure
    // function of AppState, and a real Date.now()-based mod-time would
    // make two exports of the identical state produce different bytes
    // — exactly the kind of non-determinism this format is meant to
    // avoid (docs/architecture.md §10).
    const { dosTime, dosDate } = FIXED_DOS_DATE_TIME;

    const localHeader = new DataView(new ArrayBuffer(30));
    localHeader.setUint32(0, 0x04034b50, true);
    localHeader.setUint16(4, 20, true); // version needed
    localHeader.setUint16(6, 0, true); // flags
    localHeader.setUint16(8, 0, true); // method: STORE
    localHeader.setUint16(10, dosTime, true);
    localHeader.setUint16(12, dosDate, true);
    localHeader.setUint32(14, crc, true);
    localHeader.setUint32(18, data.length, true); // compressed size
    localHeader.setUint32(22, data.length, true); // uncompressed size
    localHeader.setUint16(26, nameBytes.length, true);
    localHeader.setUint16(28, 0, true); // extra field length

    const localHeaderOffset = this.offset;
    this.pushChunk(new Uint8Array(localHeader.buffer));
    this.pushChunk(nameBytes);
    this.pushChunk(data);

    const central = new DataView(new ArrayBuffer(46));
    central.setUint32(0, 0x02014b50, true);
    central.setUint16(4, 20, true); // version made by
    central.setUint16(6, 20, true); // version needed
    central.setUint16(8, 0, true); // flags
    central.setUint16(10, 0, true); // method
    central.setUint16(12, dosTime, true);
    central.setUint16(14, dosDate, true);
    central.setUint32(16, crc, true);
    central.setUint32(20, data.length, true);
    central.setUint32(24, data.length, true);
    central.setUint16(28, nameBytes.length, true);
    central.setUint16(30, 0, true); // extra field length
    central.setUint16(32, 0, true); // comment length
    central.setUint16(34, 0, true); // disk number start
    central.setUint16(36, 0, true); // internal attrs
    central.setUint32(38, 0, true); // external attrs
    central.setUint32(42, localHeaderOffset, true);

    const centralEntry = new Uint8Array(central.byteLength + nameBytes.length);
    centralEntry.set(new Uint8Array(central.buffer), 0);
    centralEntry.set(nameBytes, central.byteLength);
    this.centralDirectory.push(centralEntry);

    this.entryCount++;
  }

  finish(): Blob {
    const centralDirectoryStart = this.offset;
    for (const entry of this.centralDirectory) {
      this.pushChunk(entry);
    }
    const centralDirectorySize = this.offset - centralDirectoryStart;

    const eocd = new DataView(new ArrayBuffer(22));
    eocd.setUint32(0, 0x06054b50, true);
    eocd.setUint16(4, 0, true); // disk number
    eocd.setUint16(6, 0, true); // disk with central directory
    eocd.setUint16(8, this.entryCount, true);
    eocd.setUint16(10, this.entryCount, true);
    eocd.setUint32(12, centralDirectorySize, true);
    eocd.setUint32(16, centralDirectoryStart, true);
    eocd.setUint16(20, 0, true); // comment length
    this.pushChunk(new Uint8Array(eocd.buffer));

    const blob = new Blob(this.chunks as BlobPart[], { type: 'application/zip' });
    this.chunks = [];
    this.centralDirectory = [];
    return blob;
  }

  private pushChunk(chunk: Uint8Array): void {
    this.chunks.push(chunk);
    this.offset += chunk.length;
  }
}

// DOS epoch (1980-01-01 00:00:00) — an arbitrary but fixed stand-in for a
// real timestamp, chosen so archive bytes depend only on frame content.
const FIXED_DOS_DATE_TIME = { dosTime: 0, dosDate: (0 << 9) | (1 << 5) | 1 };
