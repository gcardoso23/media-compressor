import type { Config } from './engine/types.ts';

// Defaults for every run, from the interface and the folder scripts alike.
const config: Config = {
  input: 'input',
  output: 'output',

  // WebP / AVIF / WebM exist to save bytes. One that isn't smaller than the
  // file it would replace is not written.
  skipLarger: true,

  images: {
    // 'original' re-compresses in the source format. Add 'webp' / 'avif' to also convert.
    formats: ['original'],

    // false: every output is pixel-exact, and is decoded and compared with the
    //        source before it is written.
    // true:  visually lossless, the trade TinyPNG makes. Much smaller, no
    //        difference you can see, but not the same pixels.
    lossy: false,

    // Proportional downscale: the aspect ratio is always kept and nothing is
    // ever enlarged. 0 = off. When several are set, the smallest result wins.
    resize: {
      maxSize: 0, // longest edge, px
      width: 0, // px
      height: 0, // px
      scale: 0, // percent of the source size
    },
    // Extra responsive widths, e.g. [640, 1280] → photo-640w.jpg next to photo.jpg
    widths: [],

    // EXIF, GPS and XMP are stripped. The colour profile is kept, because the
    // colours depend on it (a plain sRGB profile is dropped: sRGB is the default).
    keepMetadata: false,
    // Fill used when a transparent image has to become a JPEG.
    background: '#ffffff',

    // JPEG can't store new pixels losslessly. When one has to be written
    // anyway (a resized JPEG, or -f jpeg) it uses this quality and 4:4:4 chroma.
    reencodeQuality: 95,

    // visually lossless settings
    jpeg: { quality: 85 },
    png: { quality: 100, dither: 1, effort: 7 },
    webp: { quality: 85, effort: 4 },
    avif: { quality: 65, effort: 4 },
    gif: { effort: 7 },
  },

  videos: {
    // 'mp4' (H.264) plays everywhere. Add 'webm' for a smaller file in modern browsers.
    formats: ['mp4'],
    // 'vp9' is the safe WebM codec. 'av1' is smaller but slower and less widely decoded.
    webmCodec: 'vp9',

    // Same rules as images.resize.
    resize: { maxSize: 0, width: 0, height: 0, scale: 0 },
    // Cap the frame rate. 0 = keep the source rate.
    fps: 0,
    audio: true,

    // Video can't be re-encoded without loss, so every encode is measured
    // against its source with VMAF, the perceptual metric Netflix built.
    // `maxLoss` is how many VMAF points an encode may sit below a perfect copy
    // (viewers start to notice at around 6). One that loses more is redone at a
    // lower CRF, up to `attempts` times; if it still does, the source streams
    // are kept untouched whenever browsers can play them as they are.
    quality: {
      check: true,
      maxLoss: 1,
      attempts: 3,
      crfStep: 3,
    },

    // Starting CRF per codec: lower = better quality + bigger file. The scales
    // differ: these three were matched on real 1080p footage to the same score
    // (VMAF ~99.7), where VP9 came out ~43% smaller than H.264.
    h264: { crf: 18, preset: 'slow', audioBitrate: '192k' },
    vp9: { crf: 18, twoPass: true, cpuUsed: 2, audioBitrate: '128k' },
    av1: { crf: 18, preset: 6, audioBitrate: '128k' },

    // Also write a still frame for <video poster="…">.
    poster: false,
    posterAt: 0,
    posterFormat: 'jpg',
    posterQuality: 90,
  },
};

export default config;
