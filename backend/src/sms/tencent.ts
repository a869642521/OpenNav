import { sms } from 'tencentcloud-sdk-nodejs'

const Client = sms.v20210111.Client

export function isTencentSmsConfigured(): boolean {
  return (
    process.env.SMS_PROVIDER === 'tencent' &&
    Boolean(process.env.TENCENT_SMS_SECRET_ID?.trim()) &&
    Boolean(process.env.TENCENT_SMS_SECRET_KEY?.trim()) &&
    Boolean(process.env.TENCENT_SMS_SDK_APP_ID?.trim()) &&
    Boolean(process.env.TENCENT_SMS_SIGN_NAME?.trim()) &&
    Boolean(process.env.TENCENT_SMS_TEMPLATE_ID?.trim())
  )
}

/**
 * 发送登录验证码。模板需在腾讯云短信控制台审核通过；
 * 模板正文需包含 1 个变量（对应 TemplateParamSet[0]，即 6 位数字验证码）。
 * @see https://cloud.tencent.com/document/product/382/43197
 */
export async function sendTencentLoginOtp(phone11: string, code: string): Promise<void> {
  if (!isTencentSmsConfigured()) {
    throw new Error('Tencent SMS env not fully configured')
  }

  const secretId = process.env.TENCENT_SMS_SECRET_ID!.trim()
  const secretKey = process.env.TENCENT_SMS_SECRET_KEY!.trim()
  const sdkAppId = process.env.TENCENT_SMS_SDK_APP_ID!.trim()
  const signName = process.env.TENCENT_SMS_SIGN_NAME!.trim()
  const templateId = process.env.TENCENT_SMS_TEMPLATE_ID!.trim()
  const region = (process.env.TENCENT_SMS_REGION ?? 'ap-guangzhou').trim()

  const client = new Client({
    credential: { secretId, secretKey },
    region,
    profile: { httpProfile: { endpoint: 'sms.tencentcloudapi.com' } },
  })

  const resp = await client.SendSms({
    PhoneNumberSet: [`+86${phone11}`],
    SmsSdkAppId: sdkAppId,
    SignName: signName,
    TemplateId: templateId,
    TemplateParamSet: [code],
  })

  const st = resp.SendStatusSet?.[0]
  if (!st || st.Code !== 'Ok') {
    const msg = st?.Message ?? resp.RequestId ?? 'unknown'
    throw new Error(`Tencent SendSms failed: ${st?.Code ?? 'no-status'} ${msg}`)
  }
}
