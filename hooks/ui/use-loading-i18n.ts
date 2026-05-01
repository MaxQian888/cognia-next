import { useTranslations } from "next-intl"

/**
 * Returns localized default labels for the loading-state primitives
 * (ThinkingIndicator, PageLoading, InlineLoading). Components consume
 * these as `?? fallback` defaults so explicit string props always win.
 */
export function useLoadingI18n() {
  const t = useTranslations("loading")
  return {
    thinking: t("thinking"),
    pageLoading: t("pageLoading"),
    inlineLoading: t("loading"),
  }
}
