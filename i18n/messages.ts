import en from "./messages/en.json"
import { defaultLocale, type Locale } from "./config"

export type Messages = typeof en

/**
 * Eager messages for the static-export default locale. `en` is what the build
 * renders, what first paint shows, and the universal fallback while a
 * non-default locale chunk is loading. It ships in the main bundle.
 */
export const defaultMessages: Messages = en

/**
 * Per-locale message loaders. The default locale resolves synchronously to the
 * already-bundled object; every other locale is code-split via dynamic
 * `import()` so its (~930KB) JSON only enters the bundle as a separate chunk
 * when the user actually switches to it — keeping the non-default locale out of
 * the main entry bundle.
 */
const loaders: Record<Locale, () => Promise<Messages>> = {
  en: async () => en,
  "zh-CN": () => import("./messages/zh-CN.json").then((m) => m.default as Messages),
}

export function loadMessages(locale: Locale): Promise<Messages> {
  return (loaders[locale] ?? loaders[defaultLocale])()
}
