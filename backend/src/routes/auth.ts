import { Router } from 'express'
import { randomBytes, randomUUID } from 'crypto'
import {
  signToken,
  hashPassword,
  verifyPassword,
  rowToAuthUser,
  type AuthUser,
} from '../auth.js'
import {
  requireAuth,
  type AuthRequest,
  rateLimit,
  createHttpError,
} from '../middleware.js'
import { db } from '../db.js'
import { isTencentSmsConfigured, sendTencentLoginOtp } from '../sms/tencent.js'
import { isSmtpConfigured, sendEmailLoginOtp } from '../mail/otpEmail.js'
import { fetchWithTimeout } from '../httpClient.js'
import {
  validateBody,
  emailRegisterSchema,
  emailLoginSchema,
  emailOtpSendSchema,
  emailOtpVerifySchema,
  phoneSendSchema,
  phoneLoginSchema,
  exchangeSchema,
} from '../validate.js'

const QQ_TIMEOUT_MS = 10_000

const router = Router()

const FRONTEND_URL = () => process.env.FRONTEND_URL ?? 'http://localhost:5173'
const BACKEND_PUBLIC_URL = () => process.env.BACKEND_PUBLIC_URL ?? 'http://localhost:3001'

function authScope(req: { ip?: string }, raw?: string): string {
  return `${req.ip ?? 'unknown'}:${raw ?? 'unknown'}`
}

function buildFrontendRedirect(path: string, search: string): string {
  return `${FRONTEND_URL()}${path}${search}`
}

/** POST /auth/email/register */
router.post(
  '/email/register',
  validateBody(emailRegisterSchema),
  rateLimit({
    key: 'auth:email-register',
    windowMs: 10 * 60 * 1000,
    max: 8,
    message: '注册过于频繁，请稍后再试',
    keyGenerator: (req) => authScope(req, String(req.body?.email ?? '')),
  }),
  (req, res, next) => {
    try {
      const { email: em, password, name } = req.body as { email: string; password: string; name?: string }
      const exists = db.prepare('SELECT id FROM users WHERE email = ?').get(em) as { id: string } | undefined
      if (exists) {
        res.status(409).json({ error: '该邮箱已注册，请直接登录' })
        return
      }
      const id = randomUUID()
      const displayName = (name?.trim() || em.split('@')[0] || '用户').slice(0, 64)
      const hash = hashPassword(password)
      db.prepare(
        'INSERT INTO users (id, email, name, avatar, password_hash) VALUES (?, ?, ?, NULL, ?)'
      ).run(id, em, displayName, hash)
      const user: AuthUser = { id, email: em, name: displayName }
      const token = signToken(user)
      res.json({ token, user })
    } catch (err) {
      next(err)
    }
  }
)

/** POST /auth/email/login */
router.post(
  '/email/login',
  validateBody(emailLoginSchema),
  rateLimit({
    key: 'auth:email-login',
    windowMs: 10 * 60 * 1000,
    max: 12,
    message: '登录尝试过多，请 10 分钟后再试',
    keyGenerator: (req) => authScope(req, String(req.body?.email ?? '')),
  }),
  (req, res, next) => {
    try {
      const { email: em, password } = req.body as { email: string; password: string }
      const row = db
        .prepare('SELECT id, email, name, avatar, password_hash FROM users WHERE email = ?')
        .get(em) as
        | { id: string; email: string; name: string; avatar: string | null; password_hash: string | null }
        | undefined
      if (!row || !verifyPassword(password, row.password_hash)) {
        res.status(401).json({ error: '邮箱或密码错误' })
        return
      }
      const user = rowToAuthUser(row)
      const token = signToken(user)
      res.json({ token, user })
    } catch (err) {
      next(err)
    }
  }
)

/** POST /auth/email/otp/send — 发送邮箱验证码（新用户与已注册用户统一响应，避免枚举） */
router.post(
  '/email/otp/send',
  validateBody(emailOtpSendSchema),
  rateLimit({
    key: 'auth:email-otp-send',
    windowMs: 10 * 60 * 1000,
    max: 8,
    message: '验证码请求过于频繁，请稍后再试',
    keyGenerator: (req) => authScope(req, String(req.body?.email ?? '')),
  }),
  async (req, res, next) => {
    try {
      const { email: em } = req.body as { email: string }

      const code = String(Math.floor(100000 + Math.random() * 900000))
      const expiresAt = Date.now() + 5 * 60 * 1000
      db.prepare(
        'INSERT INTO email_otps (email, code, expires_at) VALUES (?, ?, ?) ON CONFLICT(email) DO UPDATE SET code = excluded.code, expires_at = excluded.expires_at'
      ).run(em, code, expiresAt)

      const isProd = process.env.NODE_ENV === 'production'
      const debug = !isProd || process.env.EMAIL_OTP_DEBUG === '1'

      const existed = db.prepare('SELECT id FROM users WHERE email = ?').get(em) as { id: string } | undefined
      console.log(`[auth:email-otp] send to ${em} registered=${Boolean(existed)} debug=${debug}`)

      if (debug) {
        res.json({
          ok: true,
          debugCode: code,
          message: isProd
            ? 'EMAIL_OTP_DEBUG=1：验证码仅用于调试，生产请配置 SMTP 并关闭 EMAIL_OTP_DEBUG'
            : '开发模式：验证码见本响应或服务器日志',
        })
        return
      }

      if (!isSmtpConfigured()) {
        res.status(503).json({ error: '未配置邮件服务，无法发送验证码' })
        return
      }

      try {
        await sendEmailLoginOtp(em, code)
      } catch (mailErr) {
        console.error('[auth:email-otp] SMTP error:', mailErr)
        res.status(502).json({ error: '邮件发送失败，请稍后重试' })
        return
      }
      res.json({ ok: true, message: '验证码已发送至邮箱' })
    } catch (err) {
      next(err)
    }
  }
)

/** POST /auth/email/otp/verify — 校验验证码；无账号则创建后登录 */
router.post(
  '/email/otp/verify',
  validateBody(emailOtpVerifySchema),
  rateLimit({
    key: 'auth:email-otp-verify',
    windowMs: 10 * 60 * 1000,
    max: 15,
    message: '验证尝试过于频繁，请稍后再试',
    keyGenerator: (req) => authScope(req, String(req.body?.email ?? '')),
  }),
  (req, res, next) => {
    try {
      const { email: em, code: c } = req.body as { email: string; code: string }

      const row = db.prepare('SELECT code, expires_at FROM email_otps WHERE email = ?').get(em) as
        | { code: string; expires_at: number }
        | undefined
      if (!row || row.code !== c || Date.now() > row.expires_at) {
        res.status(401).json({ error: '验证码无效或已过期，请重新获取' })
        return
      }
      db.prepare('DELETE FROM email_otps WHERE email = ?').run(em)

      let userRow = db
        .prepare('SELECT id, email, name, avatar FROM users WHERE email = ?')
        .get(em) as
        | { id: string; email: string; name: string; avatar: string | null }
        | undefined

      if (!userRow) {
        const id = randomUUID()
        const displayName = (em.split('@')[0] || '用户').slice(0, 64)
        db.prepare(
          'INSERT INTO users (id, email, name, avatar, password_hash) VALUES (?, ?, ?, NULL, NULL)'
        ).run(id, em, displayName)
        userRow = { id, email: em, name: displayName, avatar: null }
      }

      const user = rowToAuthUser(userRow)
      const token = signToken(user)
      res.json({ token, user })
    } catch (err) {
      next(err)
    }
  }
)

/** POST /auth/phone/send — 发送验证码（未接短信时开发环境返回 debugCode） */
router.post(
  '/phone/send',
  validateBody(phoneSendSchema),
  rateLimit({
    key: 'auth:phone-send',
    windowMs: 10 * 60 * 1000,
    max: 5,
    message: '验证码请求过于频繁，请稍后再试',
    keyGenerator: (req) => authScope(req, String(req.body?.phone ?? '')),
  }),
  async (req, res, next) => {
    try {
      const { phone: p } = req.body as { phone: string }
      const code = String(Math.floor(100000 + Math.random() * 900000))
      const expiresAt = Date.now() + 5 * 60 * 1000
      db.prepare(
        'INSERT INTO phone_otps (phone, code, expires_at) VALUES (?, ?, ?) ON CONFLICT(phone) DO UPDATE SET code = excluded.code, expires_at = excluded.expires_at'
      ).run(p, code, expiresAt)

      const isProd = process.env.NODE_ENV === 'production'
      const debug = !isProd || process.env.SMS_DEBUG === '1'

      console.log(`[auth:phone] OTP issued for ${p}: ${debug ? code : '[hidden]'}`)

      if (debug) {
        res.json({
          ok: true,
          debugCode: code,
          message: isProd
            ? 'SMS_DEBUG=1：验证码仅用于调试，生产请接入真实短信并关闭 SMS_DEBUG'
            : '开发模式：验证码见本响应或服务器日志',
        })
        return
      }

      if (isTencentSmsConfigured()) {
        try {
          await sendTencentLoginOtp(p, code)
        } catch (smsErr) {
          console.error('[auth:phone] Tencent SMS error:', smsErr)
          res.status(502).json({ error: '短信发送失败，请稍后重试' })
          return
        }
        res.json({ ok: true, message: '验证码已发送' })
        return
      }

      res.status(501).json({
        error:
          '生产环境请配置腾讯云短信：设置 SMS_PROVIDER=tencent 并填写 TENCENT_SMS_* 变量，或临时设置 SMS_DEBUG=1 仅用于联调（勿长期开启）',
      })
    } catch (err) {
      next(err)
    }
  }
)

/** POST /auth/phone/login */
router.post(
  '/phone/login',
  validateBody(phoneLoginSchema),
  rateLimit({
    key: 'auth:phone-login',
    windowMs: 10 * 60 * 1000,
    max: 10,
    message: '验证码校验次数过多，请稍后再试',
    keyGenerator: (req) => authScope(req, String(req.body?.phone ?? '')),
  }),
  (req, res, next) => {
    try {
      const { phone: p, code: c } = req.body as { phone: string; code: string }
      const row = db.prepare('SELECT code, expires_at FROM phone_otps WHERE phone = ?').get(p) as
        | { code: string; expires_at: number }
        | undefined
      if (!row || row.code !== c || Date.now() > row.expires_at) {
        res.status(401).json({ error: '验证码无效或已过期，请重新获取' })
        return
      }
      db.prepare('DELETE FROM phone_otps WHERE phone = ?').run(p)

      let userRow = db.prepare('SELECT id, email, name, avatar FROM users WHERE phone = ?').get(p) as
        | { id: string; email: string; name: string; avatar: string | null }
        | undefined

      if (!userRow) {
        const id = randomUUID()
        const email = `${p}@phone.user`
        const name = `用户${p.slice(-4)}`
        db.prepare(
          'INSERT INTO users (id, email, name, avatar, phone, password_hash) VALUES (?, ?, ?, NULL, ?, NULL)'
        ).run(id, email, name, p)
        userRow = { id, email, name, avatar: null }
      }

      const user = rowToAuthUser(userRow)
      const token = signToken(user)
      res.json({ token, user })
    } catch (err) {
      next(err)
    }
  }
)

/** POST /auth/exchange — 用一次性 auth_code 换 token */
router.post(
  '/exchange',
  validateBody(exchangeSchema),
  rateLimit({
    key: 'auth:exchange',
    windowMs: 5 * 60 * 1000,
    max: 20,
    message: '登录校验过于频繁，请稍后再试',
  }),
  (req, res, next) => {
    try {
      const { code } = req.body as { code: string }
      const row = db
        .prepare('SELECT code, token, user_id, expires_at FROM auth_exchanges WHERE code = ?')
        .get(code) as
        | { code: string; token: string; user_id: string; expires_at: number }
        | undefined
      if (!row || Date.now() > row.expires_at) {
        if (row) db.prepare('DELETE FROM auth_exchanges WHERE code = ?').run(code)
        res.status(401).json({ error: '登录态已过期，请重新登录' })
        return
      }
      db.prepare('DELETE FROM auth_exchanges WHERE code = ?').run(code)
      const userRow = db.prepare('SELECT id, email, name, avatar FROM users WHERE id = ?').get(row.user_id) as
        | { id: string; email: string; name: string; avatar: string | null }
        | undefined
      if (!userRow) {
        res.status(404).json({ error: '用户不存在' })
        return
      }
      res.json({ token: row.token, user: rowToAuthUser(userRow) })
    } catch (err) {
      next(err)
    }
  }
)

/** GET /auth/qq/start — 跳转 QQ 授权页 */
router.get(
  '/qq/start',
  rateLimit({
    key: 'auth:qq-start',
    windowMs: 10 * 60 * 1000,
    max: 20,
    message: 'QQ 登录请求过于频繁，请稍后再试',
  }),
  (req, res) => {
    const appId = process.env.QQ_APP_ID?.trim()
    const appKey = process.env.QQ_APP_KEY?.trim()
    if (!appId || !appKey) {
      res
        .status(503)
        .type('html')
        .send('<p>服务器未配置 QQ_APP_ID / QQ_APP_KEY，无法使用 QQ 登录。</p>')
      return
    }
    const state = randomBytes(24).toString('hex')
    const exp = Date.now() + 10 * 60 * 1000
    db.prepare('INSERT INTO qq_oauth_states (state, expires_at) VALUES (?, ?)').run(state, exp)
    const redirectUri = encodeURIComponent(`${BACKEND_PUBLIC_URL()}/auth/qq/callback`)
    // 必须申请 get_user_info 权限，否则回调里拉头像/昵称会失败（ret≠0）
    const scope = encodeURIComponent('get_user_info')
    const url =
      `https://graph.qq.com/oauth2.0/authorize?response_type=code` +
      `&client_id=${appId}&redirect_uri=${redirectUri}&state=${state}&scope=${scope}`
    res.redirect(url)
  }
)

/** GET /auth/qq/callback */
router.get('/qq/callback', async (req, res, next) => {
  try {
    const code = req.query.code as string | undefined
    const state = req.query.state as string | undefined
    if (!code || !state) {
      res.redirect(buildFrontendRedirect('/', '?login_error=qq_missing'))
      return
    }
    const st = db.prepare('SELECT expires_at FROM qq_oauth_states WHERE state = ?').get(state) as
      | { expires_at: number }
      | undefined
    db.prepare('DELETE FROM qq_oauth_states WHERE state = ?').run(state)
    if (!st || Date.now() > st.expires_at) {
      res.redirect(buildFrontendRedirect('/', '?login_error=qq_state'))
      return
    }

    const appId = process.env.QQ_APP_ID?.trim()
    const appKey = process.env.QQ_APP_KEY?.trim()
    if (!appId || !appKey) {
      throw createHttpError(503, 'QQ 登录未配置', false)
    }
    const redirectUri = `${BACKEND_PUBLIC_URL()}/auth/qq/callback`

    const tokenUrl =
      `https://graph.qq.com/oauth2.0/token?grant_type=authorization_code` +
      `&client_id=${encodeURIComponent(appId)}` +
      `&client_secret=${encodeURIComponent(appKey)}` +
      `&code=${encodeURIComponent(code)}` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}&fmt=json`

    const tokenRes = await fetchWithTimeout(tokenUrl, { timeoutMs: QQ_TIMEOUT_MS })
    const tokenJson = (await tokenRes.json()) as { access_token?: string; error?: number; error_description?: string }
    if (!tokenJson.access_token) {
      console.warn('[qq] token error', tokenJson)
      res.redirect(buildFrontendRedirect('/', '?login_error=qq_token'))
      return
    }
    const at = tokenJson.access_token

    const meText = await fetchWithTimeout(
      `https://graph.qq.com/oauth2.0/me?access_token=${encodeURIComponent(at)}`,
      { timeoutMs: QQ_TIMEOUT_MS }
    ).then((r) => r.text())
    const openidMatch = meText.match(/"openid":"([^"]+)"/)
    if (!openidMatch) {
      res.redirect(buildFrontendRedirect('/', '?login_error=qq_openid'))
      return
    }
    const openid = openidMatch[1]

    const infoUrl =
      `https://graph.qq.com/user/get_user_info?access_token=${encodeURIComponent(at)}` +
      `&oauth_consumer_key=${encodeURIComponent(appId)}&openid=${encodeURIComponent(openid)}`
    const infoRes = await fetchWithTimeout(infoUrl, { timeoutMs: QQ_TIMEOUT_MS })
    const info = (await infoRes.json()) as {
      nickname?: string
      figureurl_qq_2?: string
      ret?: number
      msg?: string
    }
    const okUserInfo = info.ret === undefined || info.ret === 0
    if (!okUserInfo) {
      console.warn('[qq] get_user_info failed', { ret: info.ret, msg: info.msg })
    }
    const nickname =
      okUserInfo && info.nickname?.trim() ? info.nickname.trim() : `QQ用户${openid.slice(0, 6)}`
    const avatar = okUserInfo ? info.figureurl_qq_2 || undefined : undefined
    const email = `qq_${openid}@qq.user`

    let userRow = db.prepare('SELECT id, email, name, avatar FROM users WHERE qq_openid = ?').get(openid) as
      | { id: string; email: string; name: string; avatar: string | null }
      | undefined

    if (!userRow) {
      const id = randomUUID()
      db.prepare(
        'INSERT INTO users (id, email, name, avatar, qq_openid, password_hash) VALUES (?, ?, ?, ?, ?, NULL)'
      ).run(id, email, nickname, avatar ?? null, openid)
      userRow = { id, email, name: nickname, avatar: avatar ?? null }
    } else {
      db.prepare('UPDATE users SET name = ?, avatar = ? WHERE id = ?').run(
        nickname,
        avatar ?? userRow.avatar,
        userRow.id
      )
      userRow = { ...userRow, name: nickname, avatar: avatar ?? userRow.avatar }
    }

    const user = rowToAuthUser(userRow)
    const token = signToken(user)
    const exchangeCode = randomBytes(24).toString('hex')
    db.prepare('INSERT INTO auth_exchanges (code, token, user_id, expires_at) VALUES (?, ?, ?, ?)').run(
      exchangeCode,
      token,
      user.id,
      Date.now() + 60 * 1000
    )
    res.redirect(buildFrontendRedirect('/', `?auth_code=${encodeURIComponent(exchangeCode)}`))
  } catch (err) {
    // QQ 接口超时 / 网络错误时重定向回首页而非 500
    if ((err as Error)?.name === 'FetchTimeoutError') {
      console.warn('[qq] upstream timeout')
      res.redirect(buildFrontendRedirect('/', '?login_error=qq_timeout'))
      return
    }
    next(err)
  }
})

/** GET /auth/me — 获取当前用户信息 */
router.get('/me', requireAuth, (req: AuthRequest, res) => {
  res.json({ user: req.user })
})

export default router
