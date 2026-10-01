import type en from "./messages/en.json"
import enAccount from "./messages/en/account.json"
import zhAccount from "./messages/zh-CN/account.json"
import enCommon from "./messages/en/common.json"
import zhCommon from "./messages/zh-CN/common.json"
import enLoading from "./messages/en/loading.json"
import zhLoading from "./messages/zh-CN/loading.json"
import enDiagnostics from "./messages/en/diagnostics.json"
import zhDiagnostics from "./messages/zh-CN/diagnostics.json"
import enExit from "./messages/en/exitDialog.json"
import zhExit from "./messages/zh-CN/exitDialog.json"
import enRecovery from "./messages/en/whiteScreenRecovery.json"
import zhRecovery from "./messages/zh-CN/whiteScreenRecovery.json"
import enSplash from "./messages/en/mobile/splash.json"
import zhSplash from "./messages/zh-CN/mobile/splash.json"
import { defaultLocale, type Locale } from "./config"

export type Messages = typeof en

// Startup screens reuse split sources; full catalogs stay behind dynamic imports.
export const startupMessages = {
  en: {
    account: enAccount,
    common: enCommon,
    loading: enLoading,
    diagnostics: enDiagnostics,
    exitDialog: enExit,
    whiteScreenRecovery: enRecovery,
    mobile: { splash: enSplash },
  },
  "zh-CN": {
    account: zhAccount,
    common: zhCommon,
    loading: zhLoading,
    diagnostics: zhDiagnostics,
    exitDialog: zhExit,
    whiteScreenRecovery: zhRecovery,
    mobile: { splash: zhSplash },
  },
} satisfies Record<Locale, Record<string, unknown>>

export const defaultMessages = startupMessages[defaultLocale]

const loaders: Record<Locale, () => Promise<Messages>> = {
  en: () => import("./messages/en.json").then((m) => m.default),
  "zh-CN": () => import("./messages/zh-CN.json").then((m) => m.default as Messages),
}

export function loadMessages(locale: Locale): Promise<Messages> {
  return (loaders[locale] ?? loaders[defaultLocale])()
}
