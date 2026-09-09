import { Router } from 'express'
import multer from 'multer'
import { requireRole } from '../middleware/auth.js'
import { processAndStoreImage, processAndStoreHoverImage, processAndStoreVideo, UploadError } from '../lib/uploads.js'
import { logActivity } from '../lib/log.js'

const router = Router()

// Buffered in memory (not disk) because sharp/ffmpeg re-encode from a
// buffer/temp-file — nothing the client uploads is ever written to disk
// as-is. Limits are generous "before compression" ceilings; the actual
// stored file ends up much smaller (see lib/uploads.js).
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } })
const uploadVideo = multer({ storage: multer.memoryStorage(), limits: { fileSize: 60 * 1024 * 1024 } })

// Admin-only: product/service gallery photos. Any common image format
// in, a compressed JPEG out (see lib/uploads.js — this is also where
// "auto compress large JPGs" and "convert other formats to JPG" live).
router.post('/', requireRole('admin', 'superadmin'), upload.single('file'), async (req, res) => {
  try {
    const url = await processAndStoreImage(req.file)
    await logActivity(req.user.id, 'image.uploaded')
    res.status(201).json({ url })
  } catch (err) {
    if (err instanceof UploadError) return res.status(err.status).json({ error: err.message })
    if (err.message?.includes('Input buffer')) {
      return res.status(400).json({ error: 'That file could not be read as an image.' })
    }
    throw err
  }
})

// Admin-only: the "Hover image" field, which (unlike gallery photos)
// keeps its original animated format instead of being flattened to
// JPEG, since an animated hover loop needs to actually animate.
router.post('/hover-image', requireRole('admin', 'superadmin'), upload.single('file'), async (req, res) => {
  try {
    const url = await processAndStoreHoverImage(req.file)
    await logActivity(req.user.id, 'image.uploaded')
    res.status(201).json({ url })
  } catch (err) {
    if (err instanceof UploadError) return res.status(err.status).json({ error: err.message })
    if (err.message?.includes('Input buffer')) {
      return res.status(400).json({ error: 'That file could not be read as an image.' })
    }
    throw err
  }
})

// Admin-only: looping hover clips for the Shop grid. Accepts MP4, WebM,
// or MOV and transcodes to a small, compressed MP4 (see
// compressVideo() in lib/uploads.js) — replaces the old WebM-only,
// no-compression version of this route.
router.post('/video', requireRole('admin', 'superadmin'), uploadVideo.single('file'), async (req, res) => {
  try {
    const url = await processAndStoreVideo(req.file)
    await logActivity(req.user.id, 'video.uploaded')
    res.status(201).json({ url })
  } catch (err) {
    if (err instanceof UploadError) return res.status(err.status).json({ error: err.message })
    throw err
  }
})

export default router
