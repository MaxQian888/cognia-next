/**
 * Root Suspense fallback. On a route transition it renders inside
 * `DesktopAppShell`, so TitleBar / GuildRail / StatusBar stay mounted while
 * the page streams in.
 *
 * Server component on purpose: resolves the i18n copy via
 * `getTranslations("loading.page")` so there's no client-render flash before
 * `useLoadingI18n()` warms up.
 *
 * Stands for the boot screen's `workspace` step — the last one on a cold
 * boot, and the only one on a later navigation. The screen decides which of
 * those it is from the shared timeline (`lib/boot/boot-progress.ts`).
 */

import { getTranslations } from "next-intl/server"

import { PageLoading } from "@/components/ui/loading-states"

export default async function GlobalLoading() {
  const t = await getTranslations("loading.page")
  return (
    <PageLoading
      variant="workspace"
      milestone="workspace"
      allowReload
      title={t("title")}
      description={t("description")}
    />
  )
}
