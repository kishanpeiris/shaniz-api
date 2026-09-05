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

const MAX_BYTES = 8 * 1024 * 1024 // 8MB
const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif'])

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
// { buffer, ext, contentType } ready to store. Animated GIFs are
// re-encoded frame-by-frame so hover-loop animations survive (spec
// Section 5: "Hover-state GIFs ... 2-4 sec loops").
async function reencode(file) {
  const isGif = file.mimetype === 'image/gif'
  const img = sharp(file.buffer, { animated: isGif, limitInputPixels: 268402689 })
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
  // Normalize everything else to webp: smaller files, still broadly supported.
  const buffer = await img.webp({ quality: 85 }).toBuffer()
  return { buffer, ext: 'webp', contentType: 'image/webp' }
}

// Uploads a single processed file and returns its public URL.
export async function processAndStoreImage(file) {
  validate(file)
  const { buffer, ext, contentType } = await reencode(file)
  const filename = `${crypto.randomUUID()}.${ext}`

  if (cloudinaryConfigured) {
    const dataUri = `data:${contentType};base64,${buffer.toString('base64')}`
    const result = await cloudinary.uploader.upload(dataUri, {
      folder: 'shaniz',
      public_id: filename.replace(`.${ext}`, ''),
      resource_type: 'image',
    })
    return result.secure_url
  }

  fs.writeFileSync(path.join(LOCAL_UPLOAD_DIR, filename), buffer)
  // PUBLIC_API_URL should be the API's own public origin in production
  // (e.g. https://api.shaniz.lk) so the URL resolves for site visitors,
  // not just localhost.
  const base = process.env.PUBLIC_API_URL || `http://localhost:${process.env.PORT || 4000}`
  return `${base}/uploads/${filename}`
}

export const isCloudinaryConfigured = cloudinaryConfigured
export const localUploadDir = LOCAL_UPLOAD_DIR
