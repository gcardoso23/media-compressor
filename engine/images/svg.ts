import sharp from 'sharp';
import { optimize, type Config as SvgoConfig } from 'svgo';
import { samePixels } from './pixels.ts';

// svgo's default preset: smallest output, but it renames ids and restructures the markup.
const FULL: SvgoConfig = { multipass: true };

// The default preset minus everything that renames, merges or removes
// elements, so CSS and scripts that target the markup keep working.
const STRUCTURE_SAFE: SvgoConfig = {
  multipass: true,
  plugins: [
    {
      name: 'preset-default',
      params: {
        overrides: {
          cleanupIds: false,
          collapseGroups: false,
          convertShapeToPath: false,
          inlineStyles: false,
          mergePaths: false,
          moveElemsAttrsToGroup: false,
          moveGroupAttrsToElems: false,
          removeEmptyContainers: false,
          removeHiddenElems: false,
          removeUselessDefs: false,
        },
      },
    },
  ],
};

// Only strips what never reaches the screen: comments, editor data, the XML prolog.
const MINIMAL: SvgoConfig = {
  plugins: ['removeDoctype', 'removeXMLProcInst', 'removeComments', 'removeMetadata', 'removeEditorsNSData'],
};

async function render(svg: string): Promise<Buffer | null> {
  try {
    return await sharp(Buffer.from(svg), { density: 144 }).ensureAlpha().raw().toBuffer();
  } catch {
    return null;
  }
}

// Resolves to the optimised SVG, or the source when nothing smaller is safe.
// Unless `lossy` is set, a result is only accepted when it rasterises to
// exactly the same pixels as the source.
export async function compressSvg(input: Buffer, { lossy }: { lossy: boolean }): Promise<{ data: Buffer; note?: string }> {
  const source = input.toString('utf8');
  const shrink = (config: SvgoConfig) => {
    const data = Buffer.from(optimize(source, config).data);
    return data.length < input.length ? data : null;
  };

  if (lossy) {
    const data = shrink(FULL);
    return data ? { data } : { data: input, note: 'already optimal' };
  }

  const reference = await render(source);
  for (const config of [STRUCTURE_SAFE, MINIMAL]) {
    const data = shrink(config);
    if (!data) continue;
    if (!reference) {
      // the SVG can't be rendered here, so only the tier that can't change the picture is allowed
      if (config === MINIMAL) return { data };
      continue;
    }
    const rendered = await render(data.toString('utf8'));
    if (rendered && samePixels(reference, rendered)) return { data };
  }
  return { data: input, note: 'already optimal' };
}
