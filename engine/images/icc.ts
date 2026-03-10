// Descriptions of the standard sRGB profiles that editors embed by default.
const SRGB_NAMES = new Set(['sRGB IEC61966-2.1', 'sRGB IEC61966-2-1 black scaled', 'sRGB built-in', 'sRGB2014', 'sRGB']);

// Reads the profile description ('desc' tag) out of an ICC profile.
export function profileName(icc: Buffer | undefined): string | null {
  if (!icc || icc.length < 132) return null;
  const tagCount = icc.readUInt32BE(128);
  for (let i = 0; i < tagCount; i++) {
    const entry = 132 + i * 12;
    if (entry + 12 > icc.length) return null;
    if (icc.toString('latin1', entry, entry + 4) !== 'desc') continue;

    const offset = icc.readUInt32BE(entry + 4);
    if (offset + 28 > icc.length) return null;
    const type = icc.toString('latin1', offset, offset + 4);
    if (type === 'desc') {
      // ICC v2: length-prefixed ASCII, null terminated
      const length = icc.readUInt32BE(offset + 8);
      return icc.toString('latin1', offset + 12, offset + 12 + length).replace(/\0+$/, '');
    }
    if (type === 'mluc') {
      // ICC v4: UTF-16BE records, the first one is enough
      const length = icc.readUInt32BE(offset + 20);
      const start = offset + icc.readUInt32BE(offset + 24);
      if (length % 2 || start + length > icc.length) return null;
      return Buffer.from(icc.subarray(start, start + length)).swap16().toString('utf16le');
    }
    return null;
  }
  return null;
}

// Untagged images are sRGB by definition, so an embedded sRGB profile says
// nothing new and can be dropped without changing how the image is displayed.
export function hasRedundantProfile(icc: Buffer | undefined): boolean {
  const name = profileName(icc)?.trim();
  return name !== undefined && SRGB_NAMES.has(name);
}
