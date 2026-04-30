import nodemailer from 'nodemailer'

export function isSmtpConfigured(): boolean {
  return Boolean(process.env.SMTP_HOST?.trim())
}

export async function sendEmailLoginOtp(to: string, code: string): Promise<void> {
  const host = process.env.SMTP_HOST?.trim()
  if (!host) throw new Error('SMTP_HOST not set')

  const port = Number(process.env.SMTP_PORT ?? 587)
  const secure = process.env.SMTP_SECURE === '1' || port === 465
  const user = process.env.SMTP_USER?.trim()
  const pass = process.env.SMTP_PASS ?? ''
  const from = process.env.SMTP_FROM?.trim() || user

  const transporter = nodemailer.createTransport({
    host,
    port,
    secure,
    auth: user ? { user, pass } : undefined,
  })

  await transporter.sendMail({
    from,
    to,
    subject: '登录验证码',
    text: `验证码：${code}，5 分钟内有效。请勿向他人泄露。`,
    html: `<p style="font-size:16px">你的验证码是 <strong style="letter-spacing:4px">${code}</strong></p><p style="color:#666;font-size:14px">5 分钟内有效。如非本人操作请忽略。</p>`,
  })
}
