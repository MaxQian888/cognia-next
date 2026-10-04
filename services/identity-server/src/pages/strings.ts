/**
 * Copy for the hosted pages, in the two languages Cognia ships (en, zh).
 * `strings.test.ts` pins that both dictionaries have the same keys.
 */

export type Locale = "en" | "zh"

const en = {
  "brand.account": "Account",
  "brand.tagline": "Your open workspace for AI agents",
  "signIn.choose": "Choose how you want to sign in.",
  "signIn.title": "Sign in to Cognia",
  "signIn.subtitle": "One Cognia account for all your devices.",
  "signIn.continueWith": "Continue with {provider}",
  "signIn.redirecting": "Opening {provider}…",
  "signIn.noProviders": "Sign-in is not available right now. Please try again later.",
  "signIn.startFromApp": "Open Cognia and choose Sign in to continue.",
  "signIn.failed": "Could not start sign-in. Please try again.",
  "provider.feishu": "Feishu",
  "provider.github": "GitHub",
  "provider.google": "Google",
  "provider.apple": "Apple",
  "consent.title": "Allow {client} to use your Cognia account?",
  "consent.scopes": "It will be able to:",
  "consent.allow": "Allow",
  "consent.deny": "Cancel",
  "consent.failed": "Could not save your choice. Please try again.",
  "scope.openid": "Confirm who you are",
  "scope.profile": "See your name, picture and linked sign-ins",
  "scope.email": "See your email address",
  "scope.offline_access": "Keep you signed in",
  "error.title": "Sign-in failed",
  "error.account_not_linked":
    "This email address already belongs to an account that signs in another way. Sign in with that method instead.",
  "error.access_denied": "Sign-in was cancelled.",
  "error.expired": "Sign-in took too long or was interrupted. Start again from Cognia.",
  "error.unavailable": "This sign-in method is not available.",
  "error.generic": "Something went wrong. Please try again from Cognia.",
  "error.code": "Error code: {code}",
  "error.next": "Close this page and sign in again from Cognia.",
  "return.title": "Signed in",
  "return.body": "Returning to Cognia…",
  "return.failedTitle": "Sign-in did not complete",
  "return.failedBody": "Returning to Cognia, where you can try again.",
  "return.open": "Open Cognia",
  "return.hint":
    "If Cognia did not open, use the button above. You can close this page afterwards.",
  "signedOut.title": "You are signed out",
  "signedOut.body": "You can close this window and return to Cognia.",
} as const

export type MessageKey = keyof typeof en

const zh: Record<MessageKey, string> = {
  "brand.account": "账号",
  "brand.tagline": "你的开放 AI Agent 工作空间",
  "signIn.choose": "选择一种方式登录。",
  "signIn.title": "登录 Cognia",
  "signIn.subtitle": "一个 Cognia 账号，连接你的所有设备。",
  "signIn.continueWith": "使用{provider}继续",
  "signIn.redirecting": "正在打开{provider}…",
  "signIn.noProviders": "暂时无法登录，请稍后再试。",
  "signIn.startFromApp": "请打开 Cognia 并选择「登录」以继续。",
  "signIn.failed": "无法开始登录，请重试。",
  "provider.feishu": "飞书",
  "provider.github": "GitHub",
  "provider.google": "Google",
  "provider.apple": "Apple",
  "consent.title": "允许 {client} 使用你的 Cognia 账号？",
  "consent.scopes": "它将可以：",
  "consent.allow": "允许",
  "consent.deny": "取消",
  "consent.failed": "无法保存你的选择，请重试。",
  "scope.openid": "确认你的身份",
  "scope.profile": "查看你的名字、头像和已关联的登录方式",
  "scope.email": "查看你的邮箱地址",
  "scope.offline_access": "保持登录状态",
  "error.title": "登录失败",
  "error.account_not_linked": "这个邮箱已属于一个使用其它方式登录的账号，请改用那种方式登录。",
  "error.access_denied": "已取消登录。",
  "error.expired": "登录超时或被中断，请回到 Cognia 重新开始。",
  "error.unavailable": "这种登录方式当前不可用。",
  "error.generic": "出了点问题，请回到 Cognia 重试。",
  "error.code": "错误代码：{code}",
  "error.next": "请关闭此页面，回到 Cognia 重新登录。",
  "return.title": "已登录",
  "return.body": "正在返回 Cognia…",
  "return.failedTitle": "登录未完成",
  "return.failedBody": "正在返回 Cognia，你可以在那里重试。",
  "return.open": "打开 Cognia",
  "return.hint": "如果 Cognia 没有打开，请点击上方按钮。之后可以关闭此页面。",
  "signedOut.title": "你已退出登录",
  "signedOut.body": "可以关闭此窗口并返回 Cognia。",
}

export const MESSAGES: Record<Locale, Record<MessageKey, string>> = { en, zh }

export function t(locale: Locale, key: MessageKey, params: Record<string, string> = {}): string {
  return MESSAGES[locale][key].replace(/\{(\w+)\}/g, (match, name: string) => params[name] ?? match)
}

/**
 * Pick the page language from `Accept-Language`: the highest-weighted tag
 * that is Chinese or English wins; anything else falls back to English.
 */
export function localeFrom(acceptLanguage: string | null | undefined): Locale {
  if (!acceptLanguage) return "en"
  const ranked = acceptLanguage
    .split(",")
    .map((part, index) => {
      const [tag = "", ...params] = part.trim().split(";")
      const q = params.map((param) => param.trim()).find((param) => param.startsWith("q="))
      const weight = q ? Number(q.slice(2)) : 1
      return { tag: tag.trim().toLowerCase(), weight: Number.isFinite(weight) ? weight : 0, index }
    })
    .filter((entry) => entry.tag && entry.weight > 0)
    .sort((a, b) => b.weight - a.weight || a.index - b.index)
  for (const { tag } of ranked) {
    if (tag === "zh" || tag.startsWith("zh-")) return "zh"
    if (tag === "en" || tag.startsWith("en-")) return "en"
  }
  return "en"
}
