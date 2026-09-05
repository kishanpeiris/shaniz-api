import { Router } from 'express'
import multer from 'multer'
import { requireRole } from '../middleware/auth.js'
import { processAndStoreImage, UploadError } from '../lib/uploads.js'
import { logActivity } from '../lib/log.js'

const router = Router()

// Buffered in memory (not disk) because sharp re-encodes from a buffer —
// nothing the client uploads is ever written to disk as-is.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } })

// Admin-only: used by the product/service editors in the admin panel to
// upload a product photo or hover-loop GIF and get back a URL to save on
// the record. requireRole enforces this server-side per spec Section 7.
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

export default router
