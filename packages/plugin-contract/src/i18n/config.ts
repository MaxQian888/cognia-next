/**
 * The plugin contract's share of `i18n/config.ts`, which re-exports these.
 */
import type { locales } from "@/i18n/config"

export type Locale = (typeof locales)[number]
