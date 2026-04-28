import en from "./messages/en.json"
import zhCN from "./messages/zh-CN.json"
import type { Locale } from "./config"

export type Messages = typeof en

export const allMessages: Record<Locale, Messages> = {
  en,
  "zh-CN": zhCN as Messages,
}
