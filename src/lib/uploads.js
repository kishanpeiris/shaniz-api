import sharp from 'sharp'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { fileURLToPath } from 'url'
import { v2 as cloudinary } from 'cloudinary'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Spec Section 7: "File upload validation (product images/GIFs): restrict
// file types, size limits, scan/re-encode on upload to strip malicious
// payloads." Re-encoding through sharp discards anything in the file that
// isn't actual pixel data (e.g. a polyglot file, embedded scripts in a
// crafted SVG-as-PNG, etc.) — that's the "scan" step here, there's no
// separate antivirus service in this stack.

const MAX_BYTES = 8 * 1024 * 1024 // 8MB — still images
const MAX_VIDEO_BYTES = 15 * 1024 * 1024 // 15MB — short looping hover clips only
const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif'])
const ALLOWED_VIDEO_MIME = new Set(['video/webm'])

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
    throw new UploadError('Only JPEG, PNG, WEBP, and GIF images are allowed.')
  }
  if (file.size > MAX_BYTES) {
    throw new UploadError('File is too large (max 8MB).')
  }
}

// Re-encodes the image (stripping any non-image payload) and returns a
// { buffer, ext, contentType } ready to store. Animated GIFs *and*
// animated WebPs are re-encoded frame-by-frame so hover-loop animations
// survive (spec Section 5: "Hover-state GIFs/WebPs ... 2-4 sec loops") —
// passing animated:false here for an animated WebP would silently keep
// only its first frame, so both formats opt in.
async function reencode(file) {
  const isGif = file.mimetype === 'image/gif'
  const isWebp = file.mimetype === 'image/webp'
  const img = sharp(file.buffer, { animated: isGif || isWebp, limitInputPixels: 268402689 })
  const metadata = await img.metadata()

  // Cap dimensions — product/hero images never need to be larger than
  // this, and it keeps storage + bandwidth sane.
  const MAX_DIM = 2000
  if ((metadata.width ?? 0) > MAX_DIM || (metadata.height ?? 0) > MAX_DIM) {
    img.resize({ width: MAX_DIM, height: MAX_DIM, fit: 'inside', withoutEnlargement: true })
  }

  if (isGif) {
    const buffer = await img.gif().toBuffer()
    return { buffer, ext: 'gif', contentType: 'image/gif' }
  }
  // Normalize everything else to webp: smaller files, still broadly
  // supported, and preserves animation frames when the source was
  // already an animated webp (see `animated` flag above).
  const buffer = await img.webp({ quality: 85 }).toBuffer()
  return { buffer, ext: 'webp', contentType: 'image/webp' }
}

// Shared "write this buffer somewhere public" step for both images and
// video — Cloudinary when configured, local disk otherwise.
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

// Uploads a single processed file and returns its public URL.
export async function processAndStoreImage(file) {
  validate(file)
  const { buffer, ext, contentType } = await reencode(file)
  return storeBuffer(buffer, ext, contentType, 'image')
}

// Looping hover-thumbnail videos (WebM). Unlike images, these are stored
// as-is rather than re-encoded — sharp only handles still/animated
// images, not video, and there's no video-processing library in this
// stack. The trade-off is acceptable here specifically because this
// endpoint is admin-only (requireRole in uploads.routes.js): the trust
// boundary is "someone with an admin login", not an arbitrary customer
// upload, which is the case the re-encode/strip-payload requirement in
// the spec is really guarding against. Mime type and an 8MB-scoped size
// cap are still enforced before anything is stored.
export async function processAndStoreVideo(file) {
  if (!file) throw new UploadError('No file uploaded.')
  if (!ALLOWED_VIDEO_MIME.has(file.mimetype)) {
    throw new UploadError('Only WebM video is allowed for hover clips.')
  }
  if (file.size > MAX_VIDEO_BYTES) {
    throw new UploadError('Video is too large (max 15MB) — keep hover clips short, 2-4 seconds.')
  }
  return storeBuffer(file.buffer, 'webm', 'video/webm', 'video')
}

export const isCloudinaryConfigured = cloudinaryConfigured
export const localUploadDir = LOCAL_UPLOAD_DIR
