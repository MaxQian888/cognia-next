"use client"

import { useTranslations } from "next-intl"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import { useSettingsStore } from "@/stores/settings"
import {
  SEARCH_PROVIDERS,
  isProviderConfigured,
  DEFAULT_SEARCH_PROVIDER_SETTINGS,
} from "@cognia/web-search/types"
import { SEARCH_SECTIONS, type SearchSectionId } from "./search-sections"

interface SearchSettingsNavProps {
  active: SearchSectionId
  onSelect: (id: SearchSectionId) => void
}

/** Desktop master rail — the left column of the two-pane search settings. */
export function SearchSettingsNav({ active, onSelect }: SearchSettingsNavProps) {
  const t = useTranslations("searchSettings")
  const searchProviders = useSettingsStore(
    (s) => s.settings?.searchProviders ?? DEFAULT_SEARCH_PROVIDER_SETTINGS
  )

  const total = Object.keys(SEARCH_PROVIDERS).length
  const enabledCount = Object.values(searchProviders).filter(
    (p) => p.enabled && isProviderConfigured(p.providerId, p)
  ).length

  return (
    <nav className="flex flex-col gap-1" aria-label={t("title")}>
      {SEARCH_SECTIONS.map((section) => {
        const isActive = section.id === active
        return (
          <button
            key={section.id}
            type="button"
            onClick={() => onSelect(section.id)}
            aria-current={isActive ? "page" : undefined}
            className={cn(
              "flex items-start gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors",
              isActive
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-muted hover:text-foreground"
            )}
          >
            <span className="mt-0.5 shrink-0">{section.icon}</span>
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-1.5">
                <span className="min-w-0 flex-1 truncate text-sm font-medium">
                  {t(section.labelKey)}
                </span>
                {section.id === "providers" && (
                  <Badge
                    variant={isActive ? "secondary" : "outline"}
                    className="shrink-0 px-1 py-0 text-[10px]"
                  >
                    {enabledCount}/{total}
                  </Badge>
                )}
              </span>
              <span
                className={cn(
                  "mt-0.5 line-clamp-1 text-[11px]",
                  isActive ? "text-primary-foreground/80" : "text-muted-foreground/70"
                )}
              >
                {t(section.descKey)}
              </span>
            </span>
          </button>
        )
      })}
    </nav>
  )
}
