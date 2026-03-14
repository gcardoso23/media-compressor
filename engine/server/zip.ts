import { once } from 'node:events';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { Writable } from 'node:stream';

const TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
  return value >>> 0;
});

async function crc32(file: string): Promise<number> {
  let crc = ~0;
  for await (const chunk of createReadStream(file) as AsyncIterable<Buffer>) {
    for (const byte of chunk) crc = (crc >>> 8) ^ (TABLE[(crc ^ byte) & 0xff] as number);
  }
  return ~crc >>> 0;
}

// The classic ZIP format stores sizes and offsets in 32 bits.
const LIMIT = 0xffffffff;

export interface ZipEntry {
  name: string;
  path: string;
}

interface Prepared {
  name: Buffer;
  path: string;
  size: number;
  crc: number;
  offset: number;
}

// Streams a ZIP of `entries` into `out`. Files are stored rather than
// deflated: everything that goes in here is already compressed.
export async function writeZip(out: Writable, entries: ZipEntry[]): Promise<void> {
  const files: Prepared[] = [];
  let total = 0;
  for (const entry of entries) {
    const { size } = await stat(entry.path);
    total += size;
    if (total > LIMIT) throw new Error('Too large for one ZIP (4 GB). Download the files one by one.');
    files.push({ path: entry.path, size, name: Buffer.from(entry.name), crc: await crc32(entry.path), offset: 0 });
  }

  let offset = 0;
  const write = async (buffer: Buffer) => {
    offset += buffer.length;
    if (!out.write(buffer)) await once(out, 'drain');
  };
  // shared by the local header (at 6) and the central directory record (at 8)
  const describe = (buffer: Buffer, at: number, file: Prepared) => {
    buffer.writeUInt16LE(0x0800, at); // names are UTF-8
    buffer.writeUInt16LE(0, at + 2); // stored
    buffer.writeUInt32LE(0x00210000, at + 4); // 1980-01-01, the format's zero date
    buffer.writeUInt32LE(file.crc, at + 8);
    buffer.writeUInt32LE(file.size, at + 12);
    buffer.writeUInt32LE(file.size, at + 16);
    buffer.writeUInt16LE(file.name.length, at + 20);
  };

  for (const file of files) {
    file.offset = offset;
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    describe(header, 6, file);
    await write(header);
    await write(file.name);
    for await (const chunk of createReadStream(file.path) as AsyncIterable<Buffer>) await write(chunk);
  }

  const directoryStart = offset;
  for (const file of files) {
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(20, 4);
    record.writeUInt16LE(20, 6);
    describe(record, 8, file);
    record.writeUInt32LE(file.offset, 42);
    await write(record);
    await write(file.name);
  }

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(offset - directoryStart, 12);
  end.writeUInt32LE(directoryStart, 16);
  out.end(end);
}
