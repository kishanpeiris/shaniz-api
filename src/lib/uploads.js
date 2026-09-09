import sharp from 'sharp'
import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import { fileURLToPath } from 'url'
import { v2 as cloudinary } from 'cloudinary'
import ffmpeg from 'fluent-ffmpeg'
import ffmpegPath from 'ffmpeg-static'

if (ffmpegPath) ffmpeg.setFfmpegPath(ffmpegPath)

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Spec Section 7: "File upload validation (product images/GIFs): restrict
// file types, size limits, scan/re-encode on upload to strip malicious
// payloads." Re-encoding through sharp discards anything in the file that
// isn't actual pixel data (e.g. a polyglot file, embedded scripts in a
// crafted SVG-as-PNG, etc.) — that's the "scan" step here, there's no
// separate antivirus service in this stack.

const MAX_BYTES = 15 * 1024 * 1024 // 15MB — still images, before compression
const MAX_VIDEO_BYTES = 60 * 1024 * 1024 // 60MB — before compression; compressed output is much smaller
// Any of these come in; everything still is normalized to JPEG on the
// way out (see reencode() below) so the site never has to juggle mixed
// formats for thumbnails. Animated GIF/WebP are the one exception —
// those stay in their original animated format since JPEG can't animate
// (kept only for backward compatibility with the old hover-GIF field;
// new uploads should use the hover video field instead).
const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic', 'image/heif', 'image/avif', 'image/bmp', 'image/tiff'])
const ALLOWED_VIDEO_MIME = new Set(['video/mp4', 'video/webm', 'video/quicktime', 'video/x-matroska'])

const cloudinaryConfigured = Boolean(
  process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET
)
if (cloudinaryConfigured) {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
  })
}

// Local fallback for dev / before you've created a Cloudinary account.
// Files land in <repo>/uploads and are served statically at /uploads
// (wired up in server.js). Swap to Cloudinary in production by setting
// the three CLOUDINARY_* env vars — no code changes needed either way.
const LOCAL_UPLOAD_DIR = path.join(__dirname, '../../uploads')
fs.mkdirSync(LOCAL_UPLOAD_DIR, { recursive: true })

export class UploadError extends Error {
  constructor(message) {
    super(message)
    this.status = 400
  }
}

function validate(file) {
  if (!file) throw new UploadError('No file uploaded.')
  if (!ALLOWED_MIME.has(file.mimetype)) {
    throw new UploadError('Unsupported image format. Try JPEG, PNG, WEBP, GIF, or HEIC.')
  }
  if (file.size > MAX_BYTES) {
    throw new UploadError('File is too large (max 15MB).')
  }
}

// Re-encodes the image (stripping any non-image payload) and returns a
// { buffer, ext, contentType } ready to store.
//
// Product/store-thumbnail photos (the common case — MultiImageUploader,
// the "Photos" field on products & services) are always normalized to
// JPEG: whatever format comes in (PNG, WEBP, HEIC from an iPhone, BMP,
// TIFF, ...) comes out as a single consistent, well-compressed JPEG, so
// the storefront never has to special-case formats and large source
// files (a 20MB PNG straight off a camera) get compressed down
// automatically. Quality step-down (85 → 70) kicks in if the first pass
// is still large, rather than a single fixed quality for every photo.
//
// Animated GIF/WebP is the one exception, kept for the legacy hover-GIF
// field only — JPEG can't animate, so those stay in their source
// animated format.
async function reencode(file, { forceJpeg = true } = {}) {
  const isGif = file.mimetype === 'image/gif'
  const isAnimatedWebp = file.mimetype === 'image/webp'
  const img = sharp(file.buffer, { animated: isGif || isAnimatedWebp, limitInputPixels: 268402689 })
  const metadata = await img.metadata()
  const isActuallyAnimated = Boolean(metadata.pages && metadata.pages > 1)

  // Cap dimensions — product/hero images never need to be larger than
  // this, and it keeps storage + bandwidth sane. `fit: 'inside'` keeps
  // the original aspect ratio (no cropping) — that's still decided by
  // where the image is displayed (object-cover in CSS), not baked in
  // here, so the same photo still works for both the square Shop-grid
  // thumbnail and the taller product-detail gallery.
  const MAX_DIM = 1600
  if ((metadata.width ?? 0) > MAX_DIM || (metadata.height ?? 0) > MAX_DIM) {
    img.resize({ width: MAX_DIM, height: MAX_DIM, fit: 'inside', withoutEnlargement: true })
  }

  if ((isGif || isAnimatedWebp) && isActuallyAnimated) {
    // Genuinely animated — keep it animated, in its own format. This
    // path only matters for old hover-GIF data; the admin form no
    // longer offers uploading new ones (use the hover video field).
    if (isGif) {
      const buffer = await img.gif().toBuffer()
      return { buffer, ext: 'gif', contentType: 'image/gif' }
    }
    const buffer = await img.webp({ quality: 80 }).toBuffer()
    return { buffer, ext: 'webp', contentType: 'image/webp' }
  }

  if (!forceJpeg) {
    const buffer = await img.webp({ quality: 85 }).toBuffer()
    return { buffer, ext: 'webp', contentType: 'image/webp' }
  }

  // Flatten onto white first — a transparent PNG saved straight as JPEG
  // would otherwise get a black background, since JPEG has no alpha
  // channel.
  let quality = 85
  let buffer = await img.clone().flatten({ background: '#ffffff' }).jpeg({ quality, mozjpeg: true }).toBuffer()
  if (buffer.length > 1.5 * 1024 * 1024) {
    quality = 70
    buffer = await img.clone().flatten({ background: '#ffffff' }).jpeg({ quality, mozjpeg: true }).toBuffer()
  }
  return { buffer, ext: 'jpg', contentType: 'image/jpeg' }
}

// Shared "write this buffer somewhere public" step for images, video,
// and PDFs — Cloudinary when configured, local disk otherwise.
async function storeBuffer(buffer, ext, contentType, resourceType) {
  const filename = `${crypto.randomUUID()}.${ext}`

  if (cloudinaryConfigured) {
    const dataUri = `data:${contentType};base64,${buffer.toString('base64')}`
    const result = await cloudinary.uploader.upload(dataUri, {
      folder: 'shaniz',
      public_id: filename.replace(`.${ext}`, ''),
      resource_type: resourceType,
    })
    return result.secure_url
  }

  fs.writeFileSync(path.join(LOCAL_UPLOAD_DIR, filename), buffer)
  const base = process.env.PUBLIC_API_URL || `http://localhost:${process.env.PORT || 4000}`
  return `${base}/uploads/${filename}`
}

// Uploads a single processed image and returns its public URL. Product
// and service gallery photos always come out as JPEG (see reencode()).
export async function processAndStoreImage(file) {
  validate(file)
  const { buffer, ext, contentType } = await reencode(file, { forceJpeg: true })
  return storeBuffer(buffer, ext, contentType, 'image')
}

// A hover-loop still image (the "Hover image" field) is kept as WebP —
// it needs to support genuine animation, which JPEG can't do.
export async function processAndStoreHoverImage(file) {
  validate(file)
  const { buffer, ext, contentType } = await reencode(file, { forceJpeg: false })
  return storeBuffer(buffer, ext, contentType, 'image')
}

// Looping hover-thumbnail videos. Unlike the old WebM-only version of
// this function, any common video format in is accepted and ffmpeg
// (via ffmpeg-static, a self-contained binary — no system package to
// install) transcodes it to a small, web-friendly MP4: capped at 720p,
// h264 + a moderate CRF, audio stripped entirely (hover clips are
// always muted anyway, and dropping audio shrinks the file further).
// If ffmpeg isn't available for some reason (e.g. a host that blocks
// spawning binaries), the original file is stored as-is rather than
// failing the whole upload outright — a slightly heavier video beats no
// video.
export async function processAndStoreVideo(file) {
  if (!file) throw new UploadError('No file uploaded.')
  if (!ALLOWED_VIDEO_MIME.has(file.mimetype)) {
    throw new UploadError('Unsupported video format. Try MP4, WebM, or MOV.')
  }
  if (file.size > MAX_VIDEO_BYTES) {
    throw new UploadError('Video is too large (max 60MB before compression) — keep hover clips short, 2-4 seconds.')
  }

  try {
    const compressed = await compressVideo(file.buffer)
    return storeBuffer(compressed, 'mp4', 'video/mp4', 'video')
  } catch (err) {
    console.error('Video compression failed, storing original file instead:', err.message)
    const ext = file.mimetype === 'video/webm' ? 'webm' : 'mp4'
    return storeBuffer(file.buffer, ext, file.mimetype, 'video')
  }
}

// Runs the incoming video buffer through ffmpeg via two temp files
// (fluent-ffmpeg needs real file paths, not buffers) and resolves with
// the compressed MP4 buffer. Temp files are always cleaned up, even if
// ffmpeg errors out.
function compressVideo(inputBuffer) {
  const tmpDir = os.tmpdir()
  const inPath = path.join(tmpDir, `${crypto.randomUUID()}-in`)
  const outPath = path.join(tmpDir, `${crypto.randomUUID()}-out.mp4`)
  fs.writeFileSync(inPath, inputBuffer)

  return new Promise((resolve, reject) => {
    ffmpeg(inPath)
      .noAudio()
      .videoCodec('libx264')
      .outputOptions([
        '-crf 28', // moderate compression — fine for a small, muted, looping background clip
        '-preset veryfast',
        '-movflags +faststart', // lets the browser start playing before the whole file downloads
        '-vf scale=\'min(1280,iw)\':-2', // cap width at 1280px, height auto, keeps aspect ratio
      ])
      .on('error', (err) => {
        cleanup()
        reject(err)
      })
      .on('end', () => {
        try {
          const buffer = fs.readFileSync(outPath)
          cleanup()
          resolve(buffer)
        } catch (err) {
          cleanup()
          reject(err)
        }
      })
      .save(outPath)
  })

  function cleanup() {
    fs.rm(inPath, { force: true }, () => {})
    fs.rm(outPath, { force: true }, () => {})
  }
}

// Invoice PDFs (src/lib/pdf.js) reuse the exact same "put this buffer
// somewhere public" logic as images/video — Cloudinary as a 'raw'
// resource when configured, local disk otherwise. No re-encode step
// here: the PDF is generated server-side from trusted order data, not
// uploaded by a user, so there's nothing to strip a malicious payload
// out of.
export async function storePdf(buffer) {
  return storeBuffer(buffer, 'pdf', 'application/pdf', 'raw')
}

export const isCloudinaryConfigured = cloudinaryConfigured
export const localUploadDir = LOCAL_UPLOAD_DIR
