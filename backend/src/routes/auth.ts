import { Router } from 'express'
import { verifyGoogleCredential, signToken } from '../auth.js'
import { requireAuth, type AuthRequest } from '../middleware.js'

const router = Router()

/** POST /auth/google — 用 Google credential 换取 JWT */
router.post('/google', async (req, res, next) => {
  try {
    const { credential } = req.body as { credential?: string }
    if (!credential) {
      res.status(400).json({ error: '缺少 credential 参数' })
      return
    }
    const user = await verifyGoogleCredential(credential)
    const token = signToken(user)
    res.json({ token, user })
  } catch (err) {
    next(err)
  }
})

/** GET /auth/me — 获取当前用户信息 */
router.get('/me', requireAuth, (req: AuthRequest, res) => {
  res.json({ user: req.user })
})

export default router
