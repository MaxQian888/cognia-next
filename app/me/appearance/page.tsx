"use client"

/**
 * Mobile Appearance route — full-screen wrapper around the shared
 * `<AppearanceSection />` component used in the desktop Settings sidebar.
 *
 * Why reuse instead of rebuild
 * ----------------------------
 * `<AppearanceSection />` is already responsive:
 *   - its tab strip uses `overflow-x-auto` so it scrolls on narrow screens,
 *   - every tab reads/writes through `useSettingsStore`, which the mobile
 *     client wires to the same Dexie row + companion `app_settings_update`
 *     RPC the desktop uses,
 *   - the custom theme editor, wallpaper uploader, VSCode import dialog,
 *     and contrast audit all render unchanged inside a `space-y-*` column.
 *
 * Embedding the section directly into a mobile-shell page (instead of
 * routing through `/settings?section=appearance` and its desktop sidebar
 * chrome) gives phone users a focused, back-button-driven flow while
 * still inheriting every theme feature the desktop ships.
 */

import { Suspense } from "react"
import Link from "next/link"
import { useTranslations } from "next-intl"
import { ArrowLeftIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { AppearanceSection } from "@/components/settings/appearance"

function AppearanceLoading() {
  return (
    <div className="space-y-4 px-4 py-3" aria-busy="true">
      <Skeleton className="h-7 w-1/3" />
      <Skeleton className="h-4 w-2/3" />
      <Skeleton className="h-40 w-full" />
      <Skeleton className="h-32 w-full" />
    </div>
  )
}

export default function MobileAppearancePage() {
  const t = useTranslations("mobile.me")

  return (
    <main
      className="flex h-full min-h-0 flex-1 flex-col overflow-y-auto bg-background safe-area-pt"
      data-testid="mobile-appearance-page"
    >
      <header className="sticky top-0 z-10 flex items-center gap-2 border-b bg-background/95 px-3 py-2 backdrop-blur supports-[backdrop-filter]:bg-background/75">
        <Button
          asChild
          variant="ghost"
          size="icon"
          aria-label={t("appearanceBackAria")}
          data-testid="mobile-appearance-back"
        >
          <Link href="/me">
            <ArrowLeftIcon className="size-5" aria-hidden="true" />
          </Link>
        </Button>
        <h1 className="text-base font-semibold tracking-tight">{t("sectionAppearance")}</h1>
      </header>

      <section className="px-4 py-4">
        <Suspense fallback={<AppearanceLoading />}>
          <AppearanceSection />
        </Suspense>
      </section>
    </main>
  )
}
