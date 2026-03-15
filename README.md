# media-compressor

A local workbench for getting images and videos ready for the web **without losing quality**: smaller files, the same pixels, with optional WebP / AVIF / WebM versions.

It runs entirely on your machine. Nothing is uploaded anywhere.

## Setup

```sh
git clone https://github.com/gcardoso23/media-compressor.git
cd media-compressor
npm install
npm run dev
```

Then open http://localhost:3000.

**Needs:** Node 20.12 or newer, plus two command-line tools that are free on Homebrew:

```sh
brew install ffmpeg       # videos, and the video quality check
brew install jpeg-turbo   # lossless JPEG optimisation (jpegtran)
```

Without `ffmpeg` only images work. Without `jpegtran`, JPEGs are passed through untouched.

## The interface

1. Drop images and videos onto the page, a whole folder, or paste from the clipboard.
2. The settings for what you dropped appear: one set for all images and one for all videos. Any single file can be customised on its own.
3. Press **Compress**. Each file shows what it weighed and what it weighs now, per format, with a download button. **Download all** gives a ZIP.

Change a setting afterwards and the affected files are marked; pressing Compress again redoes only those. Working files live in a temporary folder that is removed when the server stops.

## Whole folders at once

For batches, put files (or folders) in `input/` and run one of these. Results land in `output/` with the same folder structure, and a second run only redoes what changed. Neither folder is ever committed.

```sh
npm run images          # compress, same format
npm run images:webp     # … and also write WebP
npm run videos          # compress to MP4 (H.264)
npm run videos:webm     # … and also write WebM
npm run web             # all of the above in one go
```

Any setting can be added after `--`, and folders elsewhere on your machine work too:

```sh
npm run images -- --webp --max-size 1920
npm run compress -- images ~/Desktop/shots --out ~/Desktop/shots-web --webp
npm run compress -- --help    # every option
```

## What "without losing quality" means

### Images are pixel-exact, and checked

Every image output is decoded again and compared with its source, sample by sample, **before it is written**. An encoding that changes anything is thrown away, so the guarantee doesn't rest on encoder settings being right.

| Source | What happens |
| --- | --- |
| PNG | Best of several lossless encodings. Stored as an indexed PNG when it has 256 colours or fewer, and an alpha channel that is fully opaque is dropped. |
| JPEG | Repacked with `jpegtran`: the compressed image data is not touched, only stored more efficiently. |
| WebP / AVIF | Kept as they are, unless an exact re-encode is smaller. |
| GIF | Kept as it is, unless an exact re-encode is smaller. As WebP it becomes a lossless animated WebP with the same frames and timing. |
| SVG | Optimised with svgo, accepted only if it renders to the same pixels. Ids and structure are kept, so CSS and scripts targeting them still work. |
| TIFF | Converted to PNG. |

Also preserved: 16-bit depth, greyscale, wide-gamut colour profiles (Display P3 and others), and EXIF rotation. Stripped: EXIF, GPS, XMP, and embedded sRGB profiles (sRGB is what browsers assume anyway).

A file is never made bigger:

- If nothing beats the source, the source is copied through byte for byte ("already optimal").
- A WebP / AVIF that isn't smaller than the file it would replace is not written. This is what happens to **JPEG photos**: a pixel-exact WebP of a JPEG is several times larger than the JPEG itself. Getting a smaller WebP out of a JPEG needs visually lossless mode.
- A format that can't hold an image exactly is skipped, for example a 16-bit PNG as WebP.

The only image outputs that aren't pixel-exact are the ones that can't be: a **resized JPEG** (JPEG has no lossless mode, so it is written at q95 with full chroma) and a resized GIF. Both are labelled.

### Visually lossless: the TinyPNG trade

TinyPNG is not lossless. It reduces PNGs to a smart 256-colour palette and re-encodes JPEGs, which looks identical but isn't. Visually lossless mode (`--lossy` on the command line) does the same, and the difference in size is large. Measured on a 4096×2731 photo cut-out, a 3456×1986 screenshot and three small JPEGs:

| | Pixel-exact (default) | Visually lossless |
| --- | --- | --- |
| JPEG | −24% | −58% |
| PNG | −3% | −64% |
| PNG → WebP | −30% | −91% |
| PNG → AVIF | −18% on the photo, skipped for the screenshot | −94% |

Photos stored as PNG barely shrink losslessly; that is the nature of lossless compression, and exactly the gap TinyPNG closes by being lossy. 16-bit images always stay pixel-exact.

### Videos are measured

Video can't be re-encoded without loss at a size the web can use, so the default is tuned to be indistinguishable from the source and then **verified per file**:

1. The video is encoded at a visually lossless quality (CRF 18).
2. The result is scored against the source with [VMAF](https://github.com/Netflix/vmaf), Netflix's perceptual quality metric.
3. If it sits more than **1 VMAF point** below a perfect copy, it is encoded again at higher quality (up to 3 attempts). Viewers start to notice at around 6 points.
4. If no encode holds quality, or the encode isn't smaller, and the source is already something browsers play (H.264 in MP4, VP9 in WebM), its streams are **copied bit for bit** instead.

`VMAF 97.4 of 98.2` means a perfect copy of that footage would itself only score 98.2 (footage with little motion tops out below 100), so 0.8 points were lost.

Measured on 1080p footage (a 16.5 Mbit/s H.264 export):

| | Size | VMAF |
| --- | --- | --- |
| MP4 (H.264) | −56% | 99.8 |
| WebM (VP9) | −75% | 99.7 |

Also handled: phone footage with a rotation flag, odd frame sizes, HDR (tone-mapped to SDR, with a warning), transparency (kept in VP9 WebM, dropped with a warning in MP4), surround sound (downmixed to stereo). Metadata is stripped, and MP4s are written with the index first so playback starts while downloading.

Ship both formats, WebM first:

```html
<video poster="intro-poster.jpg" controls playsinline>
  <source src="intro.webm" type="video/webm" />
  <source src="intro.mp4" type="video/mp4" />
</video>
```

## Resizing

Always proportional: the aspect ratio is kept and nothing is ever enlarged. Works for images and videos.

```sh
npm run images -- --max-size 1920    # longest edge at most 1920px
npm run images -- --width 1200       # at most 1200px wide
npm run images -- --height 800       # at most 800px tall
npm run images -- --scale 50         # half the size
npm run images -- --widths 640,1280  # extra responsive files: photo-640w.jpg, photo-1280w.jpg
```

When several limits are set, the smallest result wins. Resized pixels are still stored exactly, except for JPEG and GIF as noted above.

## Defaults

Every default lives in [media.config.ts](media.config.ts), with a comment on each: formats, quality settings, video CRF and the VMAF tolerance. Change them there and both the interface and the folder scripts pick them up.

## How it's organised

```
app/                    Next.js: the page and the API routes behind it
components/             the interface (React)
lib/                    browser-side helpers: API calls, settings, formatting
engine/                 everything that touches files, shared by the interface and the scripts
  images/               pixel-exact and visually lossless encoders, the pixel check
  videos/               ffmpeg encodes, the VMAF quality gate
  server/               upload store, file responses, "Download all"
  cli.ts                the folder scripts
  options.ts            settings shared by the interface and the folder scripts
  plan.ts               which files to write for each source
media.config.ts         every default, documented
bin/compress.ts         entry point for the folder scripts
test/                   npm test
```

## Development

```sh
npm run dev         # the interface, reloading on change
npm run typecheck   # strict TypeScript across the engine, the API and the interface
npm test            # the engine, the folder scripts and the API routes
npm run build       # production build of the interface (then npm start)
```

The core assertion of the test suite is the promise above: every lossless output decodes to exactly the source's pixels.
