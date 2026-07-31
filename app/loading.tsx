/**
 * Root Suspense fallback. Renders inside `DesktopAppShell`, so TitleBar /
 * GuildRail / StatusBar stay mounted while a page streams in.
 *
 * Server component on purpose: resolves the i18n copy via
 * `getTranslations("loading.page")` so there's no client-render flash before
 * `useLoadingI18n()` warms up.
 */

import { getTranslations } from "next-intl/server"

import { PageLoading } from "@/components/ui/loading-states"

export default async function GlobalLoading() {
  const t = await getTranslations("loading.page")
  return (
    <PageLoading
      variant="workspace"
      allowReload
      title={t("title")}
      description={t("description")}
    />
  )
}
