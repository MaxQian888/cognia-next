import { useTranslations } from "next-intl"

/**
 * Returns localized default labels for the loading-state primitives
 * (ThinkingIndicator, PageLoading, InlineLoading, LoadingRegion). Components
 * consume these as `?? fallback` defaults so explicit string props always win.
 *
 * `components/ui/` is exempt from `lint:i18n`, which is exactly how the shared
 * spinner came to ship a hard-coded English `aria-label`. Routing every default
 * through this hook is what stops that recurring.
 */
export function useLoadingI18n() {
  const t = useTranslations("loading")
  return {
    thinking: t("thinking"),
    pageLoading: t("pageLoading"),
    inlineLoading: t("loading"),
    /** Generic region announcement used when the caller supplies no label. */
    loading: t("loading"),
    /** Reassurance once a wait turns prolonged; carries the elapsed seconds. */
    stillWorking: (seconds: number) => t("stillWorking", { seconds }),
    /** Replaces the elapsed count when the device reports no connection. */
    offline: t("offline"),
    cancel: t("cancel"),
  }
}
