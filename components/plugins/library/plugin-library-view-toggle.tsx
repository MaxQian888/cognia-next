"use client"

// Compact list vs card grid toggle. Persists through the plugins store
// (`listViewMode`), which is the single field on that store wired to the
// Zustand `persist` middleware — the preference therefore survives
// reloads. Uses the shadcn ToggleGroup primitive so styling stays
// consistent with the rest of the app's view-mode controls.

import { useTranslations } from "next-intl"
import { LayoutGridIcon, ListIcon } from "lucide-react"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { usePluginsStore, type PluginListViewMode } from "@/stores/plugins"

export function PluginLibraryViewToggle() {
  const t = useTranslations("plugins.view")
  const mode = usePluginsStore((s) => s.listViewMode)
  const setMode = usePluginsStore((s) => s.setListViewMode)

  return (
    <ToggleGroup
      type="single"
      size="sm"
      value={mode}
      onValueChange={(value) => {
        if (value === "list" || value === "card") {
          setMode(value as PluginListViewMode)
        }
      }}
      aria-label={t("toggleAria")}
      data-testid="plugin-library-view-toggle"
    >
      <ToggleGroupItem value="list" aria-label={t("list")} data-testid="plugin-library-view-list">
        <ListIcon className="size-3.5" />
      </ToggleGroupItem>
      <ToggleGroupItem value="card" aria-label={t("card")} data-testid="plugin-library-view-card">
        <LayoutGridIcon className="size-3.5" />
      </ToggleGroupItem>
    </ToggleGroup>
  )
}
