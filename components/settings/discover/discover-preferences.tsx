"use client"

/**
 * Settings → Discover preferences. Two global defaults for the `/discover`
 * page, persisted on `AppSettings.discoverDefaults` via `useDiscoverPreferences`:
 *
 *  - **Landing category** — which category the page opens on (Auto → first
 *    visible). Options are restricted to currently-visible categories (+ the
 *    always-available Favorites) so a hidden category can't become the landing.
 *  - **Default view** — the grid/list/compact fallback for categories without
 *    an explicit per-category override.
 *
 * Rendered above `<DiscoverCustomizer />` in `discover-section.tsx`.
 */

import * as React from "react"
import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { useDiscoverLayout } from "@/hooks/discover/use-discover-layout"
import { useDiscoverPreferences } from "@/hooks/discover/use-discover-preferences"
import {
  DISCOVER_VIEW_MODES,
  FAVORITES_CATEGORY,
  isValidView,
  isValidViewMode,
} from "@/lib/discover/categories"

export function DiscoverPreferences(): React.ReactElement {
  const t = useTranslations("discover")
  const { resolved } = useDiscoverLayout()
  const { preferences, setLandingCategory, setDefaultView, isDefault, reset } =
    useDiscoverPreferences()

  const visible = [...resolved.pinned, ...resolved.overflow]

  return (
    <section className="space-y-4" data-testid="discover-preferences">
      <div className="flex items-center justify-between gap-2">
        <div className="space-y-1">
          <h3 className="text-sm font-semibold">{t("preferences.title")}</h3>
          <p className="text-xs text-muted-foreground">{t("preferences.description")}</p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={isDefault}
          onClick={() => void reset()}
          data-testid="discover-preferences-reset"
        >
          {t("preferences.reset")}
        </Button>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="discover-landing-select" className="text-sm font-medium">
            {t("preferences.landingLabel")}
          </label>
          <NativeSelect
            id="discover-landing-select"
            className="w-full"
            value={preferences.landingCategory ?? ""}
            onChange={(e) => {
              const value = e.target.value
              void setLandingCategory(value === "" ? null : isValidView(value) ? value : null)
            }}
            data-testid="discover-landing-select"
          >
            <NativeSelectOption value="">{t("preferences.landingAuto")}</NativeSelectOption>
            <NativeSelectOption value={FAVORITES_CATEGORY}>
              {t("categories.favorites")}
            </NativeSelectOption>
            {visible.map((cat) => (
              <NativeSelectOption key={cat.id} value={cat.id}>
                {t(`categories.${cat.id}`)}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          <p className="text-xs text-muted-foreground">{t("preferences.landingHint")}</p>
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="discover-view-select" className="text-sm font-medium">
            {t("preferences.viewLabel")}
          </label>
          <NativeSelect
            id="discover-view-select"
            className="w-full"
            value={preferences.view}
            onChange={(e) => {
              const value = e.target.value
              if (isValidViewMode(value)) void setDefaultView(value)
            }}
            data-testid="discover-view-select"
          >
            {DISCOVER_VIEW_MODES.map((mode) => (
              <NativeSelectOption key={mode} value={mode}>
                {t(`view.${mode}`)}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          <p className="text-xs text-muted-foreground">{t("preferences.viewHint")}</p>
        </div>
      </div>
    </section>
  )
}
