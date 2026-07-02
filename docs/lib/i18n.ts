import { defineI18n } from "fumadocs-core/i18n"

export const i18n = defineI18n({
  defaultLanguage: "zh",
  languages: ["zh", "en"],
  // Explicit locale prefixes everywhere (D8): hiding the default locale
  // requires the i18n middleware to rewrite unprefixed URLs, and middleware
  // does not exist in a static export. `public/_redirects` maps the bare
  // roots onto /zh/ on Cloudflare Pages.
  hideLocale: "never",
  parser: "dir",
})
