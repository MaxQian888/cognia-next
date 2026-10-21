/** Keep this value aligned with Logto's verificationCodePolicy.expirationDuration. */
export const CODE_TTL_SECONDS = 300

export const PURPOSES = {
  SignIn: ["sign-in", "登录"],
  Register: ["registration", "注册"],
  ForgotPassword: ["password reset", "重置密码"],
  Generic: ["verification", "验证"],
} as const

export interface MailInput {
  to: string
  type: keyof typeof PURPOSES
  code: string
  locale: "zh" | "en"
}

export interface EmailMessage {
  from: { email: string; name: string }
  to: string
  subject: string
  text: string
  html: string
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]!
  })
}

/** Table layout and inline styles work in email clients without external assets. */
export function renderEmail(input: MailInput, from: string): EmailMessage {
  const zh = input.locale === "zh"
  const purpose = PURPOSES[input.type][zh ? 1 : 0]
  const subject = zh ? `Cognia ${purpose}验证码` : `Your Cognia ${purpose} code`
  const title = zh ? `确认本次${purpose}` : `Confirm your ${purpose}`
  const intro = zh
    ? "在验证页面输入以下验证码，继续你的操作。"
    : "Enter this code on the verification page to continue."
  const expiry = zh
    ? "5 分钟内有效 · 仅限本次验证使用"
    : "Valid for 5 minutes · For this verification only"
  const safety = zh
    ? "请勿将验证码分享给任何人。Cognia 不会要求你通过聊天或电话提供验证码。"
    : "Keep this code private. Cognia will never ask for your code in a chat or phone call."
  const unsolicited = zh
    ? "如果不是你本人操作，请忽略此邮件。不要向他人转发。"
    : "If you didn’t request this email, ignore it. Don’t forward it to anyone."
  const preheader = zh
    ? "你收到了一个 Cognia 账号验证请求。"
    : "You received a Cognia account verification request."
  const label = zh ? "你的验证码" : "YOUR VERIFICATION CODE"
  const footer = zh
    ? "Cognia 账号安全 · 自动发送，请勿回复"
    : "Cognia account security · This mailbox isn’t monitored"
  const code = escapeHtml(input.code)
  const html = `<!doctype html>
<html lang="${zh ? "zh-CN" : "en"}">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark">
<meta name="format-detection" content="telephone=no,date=no,address=no,email=no">
<title>${escapeHtml(subject)}</title>
<style>
@media screen and (max-width:480px){.outer{padding:24px 12px!important}.content{padding:28px 24px!important}.otp{font-size:32px!important;letter-spacing:6px!important}}
@media (prefers-color-scheme: dark){.canvas{background:#10151d!important}.card{background:#19222d!important;border-color:#344253!important}.ink{color:#f4f7fb!important}.muted{color:#b9c5d4!important}.code-panel{background:#202e41!important;border-color:#526fdd!important}.otp{color:#c4d1ff!important}.divider{border-color:#344253!important}}
a[x-apple-data-detectors]{color:inherit!important;text-decoration:none!important}
</style>
</head>
<body class="canvas" style="margin:0;padding:0;background:#f2f5f9;color:#182333;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',Arial,sans-serif">
<div style="display:none;font-size:1px;line-height:1px;color:transparent;max-height:0;max-width:0;overflow:hidden;mso-hide:all">${preheader}</div><!-- /preheader -->
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr><td class="outer" align="center" style="padding:48px 20px">
<table role="presentation" width="560" cellspacing="0" cellpadding="0" border="0" style="width:100%;max-width:560px">
<tr><td style="padding:0 4px 22px"><span class="ink" style="font-size:24px;line-height:32px;font-weight:750;letter-spacing:-1px;color:#182333">Cognia<span style="color:#335cff">.</span></span></td></tr>
<tr><td class="card content" style="background:#ffffff;border:1px solid #dfe6ee;border-radius:18px;padding:40px 36px">
<p class="muted" style="margin:0 0 18px;font-size:11px;line-height:18px;font-weight:600;letter-spacing:1.5px;color:#607086">${zh ? "账号验证" : "ACCOUNT VERIFICATION"}</p>
<h1 class="ink" style="margin:0 0 12px;font-size:26px;line-height:1.4;font-weight:700;letter-spacing:-.5px;color:#182333">${title}</h1>
<p class="muted" style="margin:0 0 28px;font-size:15px;line-height:1.8;color:#607086">${intro}</p>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr><td class="code-panel" align="center" style="padding:24px 8px;background:#f1f5ff;border:1px solid #d4dfff;border-radius:12px">
<p class="muted" style="margin:0 0 10px;font-size:10px;line-height:16px;letter-spacing:1.5px;color:#607086">${label}</p>
<div class="otp" dir="ltr" style="font-family:'SFMono-Regular',Consolas,'Liberation Mono',monospace;font-size:40px;line-height:56px;letter-spacing:8px;font-weight:700;white-space:nowrap;color:#284bca">${code}</div>
</td></tr></table>
<p class="muted" style="margin:14px 0 28px;text-align:center;font-size:12px;line-height:20px;color:#607086">${expiry}</p>
<div class="divider" style="border-top:1px solid #e6ebf1;padding-top:22px">
<p class="ink" style="margin:0 0 8px;font-size:13px;line-height:1.8;color:#34445b">${safety}</p>
<p class="muted" style="margin:0;font-size:12px;line-height:1.8;color:#607086">${unsolicited}</p>
</div></td></tr>
<tr><td class="muted" style="padding:22px 4px 0;font-size:11px;line-height:20px;color:#748398">${footer}</td></tr>
</table></td></tr></table>
</body></html>`
  return {
    from: { email: from, name: "Cognia" },
    to: input.to,
    subject,
    text: `${title}\n\n${intro}\n\n${input.code}\n\n${expiry}\n\n${safety}\n\n${unsolicited}`,
    html,
  }
}
