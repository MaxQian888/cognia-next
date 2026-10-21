import type { Locale } from "@cognia/plugin-contract/i18n/config"
export type { Locale } from "@cognia/plugin-contract/i18n/config"

export const locales = ["en", "zh-CN"] as const
export const defaultLocale: Locale = "en"
