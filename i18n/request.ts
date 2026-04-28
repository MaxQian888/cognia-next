import { getRequestConfig } from "next-intl/server"
import { defaultLocale } from "./config"

// Static export: build-time renders only the default locale.
// Runtime locale switching is handled client-side by LocaleProvider.
export default getRequestConfig(async () => {
  return {
    locale: defaultLocale,
    messages: (await import(`./messages/${defaultLocale}.json`)).default,
  }
})
