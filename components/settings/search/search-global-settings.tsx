"use client"

import { useState } from "react"
import { useTranslations } from "next-intl"
import { Globe, Plus, AlertCircle } from "lucide-react"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Slider } from "@/components/ui/slider"
import { Badge } from "@/components/ui/badge"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import {
  SettingsGrid,
  SettingsGroup,
  SettingsToggle,
  SettingsAlert,
} from "@/components/settings/common/settings-section"
import { useSettingsStore } from "@/stores/settings"
import {
  type SearchProviderType,
  SEARCH_PROVIDERS,
  isProviderConfigured,
  DEFAULT_SEARCH_PROVIDER_SETTINGS,
} from "@cognia/web-search/types"
import { SEARCH_SOURCES } from "@cognia/web-search/search-constants"
import { cn } from "@/lib/utils"
import { createLogger } from "@cognia/logging"
import { SourcePill } from "./_shared/source-pill"

const log = createLogger("settings.search.global")

interface SearchGlobalSettingsProps {
  /** Navigate to the Providers section — wired by the settings shell. */
  onConfigureProviders?: () => void
}

export function SearchGlobalSettings({ onConfigureProviders }: SearchGlobalSettingsProps) {
  const t = useTranslations("searchSettings")

  const settings = useSettingsStore((s) => s.settings)
  const setSearchEnabled = useSettingsStore((s) => s.setSearchEnabled)
  const setSearchMaxResults = useSettingsStore((s) => s.setSearchMaxResults)
  const setSearchFallbackEnabled = useSettingsStore((s) => s.setSearchFallbackEnabled)
  const setSearchMaxRetries = useSettingsStore((s) => s.setSearchMaxRetries)
  const setDefaultSearchProvider = useSettingsStore((s) => s.setDefaultSearchProvider)
  const setDefaultSearchSources = useSettingsStore((s) => s.setDefaultSearchSources)
  const addCustomSearchSource = useSettingsStore((s) => s.addCustomSearchSource)
  const removeCustomSearchSource = useSettingsStore((s) => s.removeCustomSearchSource)

  const searchEnabled = settings?.searchEnabled ?? false
  const searchMaxResults = settings?.searchMaxResults ?? 5
  const searchFallbackEnabled = settings?.searchFallbackEnabled ?? true
  const searchMaxRetries = settings?.searchMaxRetries ?? 2
  const defaultSearchProvider: SearchProviderType = settings?.defaultSearchProvider ?? "tavily"
  const defaultSearchSources = settings?.defaultSearchSources ?? []
  const searchProviders = settings?.searchProviders ?? DEFAULT_SEARCH_PROVIDER_SETTINGS
  const customSearchSources = settings?.customSearchSources ?? []

  const [newSourceName, setNewSourceName] = useState("")
  const [addSourceOpen, setAddSourceOpen] = useState(false)

  const providerIds = Object.keys(SEARCH_PROVIDERS) as SearchProviderType[]
  const configuredProviders = providerIds.filter((id) => {
    const s = searchProviders[id]
    return !!s?.enabled && isProviderConfigured(id, s)
  })
  const hasUsableProvider = configuredProviders.length > 0

  const toggleSearchSource = (sourceId: string) => {
    const wasSelected = defaultSearchSources.includes(sourceId)
    log.info("source_toggled", { sourceId, selected: !wasSelected })
    if (wasSelected) {
      void setDefaultSearchSources(defaultSearchSources.filter((s) => s !== sourceId))
    } else {
      void setDefaultSearchSources([...defaultSearchSources, sourceId])
    }
  }

  const handleAddCustomSource = () => {
    const name = newSourceName.trim()
    if (!name) return
    const id = `custom-${Date.now()}`
    log.info("custom_source_added", { id, name })
    void addCustomSearchSource({ id, name })
    setNewSourceName("")
    setAddSourceOpen(false)
  }

  return (
    <div className="space-y-4">
      {!hasUsableProvider && (
        <SettingsAlert
          icon={<AlertCircle className="h-4 w-4" />}
          title={t("noProviders")}
          action={
            onConfigureProviders && (
              <Button size="sm" variant="outline" onClick={onConfigureProviders}>
                {t("providers")}
              </Button>
            )
          }
        >
          {t("configureProviderHint")}
        </SettingsAlert>
      )}

      <SettingsGrid columns={2}>
        <SettingsToggle
          id="search-enabled"
          label={t("enableSearch")}
          checked={searchEnabled}
          onCheckedChange={(v) => {
            log.info("search_enabled_changed", { enabled: v })
            void setSearchEnabled(v)
          }}
        />
        <SettingsToggle
          id="search-fallback"
          label={t("fallbackEnabled")}
          checked={searchFallbackEnabled}
          disabled={!searchEnabled}
          onCheckedChange={(v) => {
            log.info("fallback_changed", { enabled: v })
            void setSearchFallbackEnabled(v)
          }}
        />
      </SettingsGrid>

      <SettingsGrid columns={2}>
        <div className="space-y-2">
          <Label className="text-sm">{t("defaultProvider")}</Label>
          <Select
            value={defaultSearchProvider}
            onValueChange={(v) => {
              log.info("default_provider_changed", { provider: v })
              void setDefaultSearchProvider(v as SearchProviderType)
            }}
            disabled={!searchEnabled || configuredProviders.length === 0}
          >
            <SelectTrigger className="w-full">
              <SelectValue placeholder={t("selectProvider")} />
            </SelectTrigger>
            <SelectContent>
              {configuredProviders.length > 0 ? (
                configuredProviders.map((id) => (
                  <SelectItem key={id} value={id}>
                    <span className="flex items-center gap-2">
                      {SEARCH_PROVIDERS[id].name}
                      {searchProviders[id]?.priority === 1 && (
                        <Badge variant="outline" className="text-[10px] px-1 py-0">
                          {t("primary")}
                        </Badge>
                      )}
                    </span>
                  </SelectItem>
                ))
              ) : (
                <SelectItem value="tavily" disabled>
                  {t("noProviders")}
                </SelectItem>
              )}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-2">
          <Label className="text-sm">
            {t("maxResults")}: {searchMaxResults}
          </Label>
          <Slider
            value={[searchMaxResults]}
            onValueChange={([v]) => void setSearchMaxResults(v)}
            onValueCommit={([value]) => log.info("max_results_changed", { value })}
            min={1}
            max={10}
            step={1}
            disabled={!searchEnabled}
          />
        </div>
      </SettingsGrid>

      <div className="space-y-2">
        <Label className="text-sm">
          {t("maxRetries")}: {searchMaxRetries}
        </Label>
        <Slider
          value={[searchMaxRetries]}
          onValueChange={([v]) => void setSearchMaxRetries(v)}
          onValueCommit={([value]) => log.info("max_retries_changed", { value })}
          min={0}
          max={5}
          step={1}
          disabled={!searchEnabled}
        />
        <p className="text-[10px] text-muted-foreground">{t("maxRetriesDesc")}</p>
      </div>

      <SettingsGroup
        title={t("researchSources")}
        icon={<Globe className="h-4 w-4" />}
        badge={`${defaultSearchSources.length + customSearchSources.length} ${t("selected")}`}
      >
        <div className="flex flex-wrap gap-2">
          {SEARCH_SOURCES.map((source) => (
            <SourcePill
              key={source.id}
              sourceId={source.id}
              name={source.name}
              icon={source.icon}
              selected={defaultSearchSources.includes(source.id)}
              disabled={!searchEnabled}
              onToggle={() => toggleSearchSource(source.id)}
            />
          ))}
          {customSearchSources.map((source) => {
            const isSelected = defaultSearchSources.includes(source.id)
            return (
              <SourcePill
                key={source.id}
                sourceId={source.id}
                name={source.name}
                icon={source.icon}
                selected={isSelected}
                disabled={!searchEnabled}
                onToggle={() => toggleSearchSource(source.id)}
                onRemove={() => {
                  log.info("custom_source_removed", { id: source.id })
                  void removeCustomSearchSource(source.id)
                  if (isSelected) {
                    void setDefaultSearchSources(
                      defaultSearchSources.filter((s) => s !== source.id)
                    )
                  }
                }}
              />
            )
          })}
          <Dialog open={addSourceOpen} onOpenChange={setAddSourceOpen}>
            <DialogTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={!searchEnabled}
                className={cn(
                  "h-auto gap-1 rounded-full border-dashed px-3 py-1.5 text-xs font-medium",
                  searchEnabled
                    ? "cursor-pointer hover:bg-muted/50 text-muted-foreground"
                    : "opacity-50 cursor-not-allowed text-muted-foreground"
                )}
              >
                <Plus className="h-3 w-3" />
                <span>{t("addCustomSource")}</span>
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>{t("addCustomSourceTitle")}</DialogTitle>
                <DialogDescription>{t("addCustomSourceDesc")}</DialogDescription>
              </DialogHeader>
              <Input
                value={newSourceName}
                onChange={(e) => setNewSourceName(e.target.value)}
                placeholder={t("sourceNamePlaceholder")}
                onKeyDown={(e) => e.key === "Enter" && handleAddCustomSource()}
              />
              <DialogFooter>
                <Button variant="outline" onClick={() => setAddSourceOpen(false)}>
                  {t("cancel")}
                </Button>
                <Button onClick={handleAddCustomSource} disabled={!newSourceName.trim()}>
                  {t("add")}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
        <p className="text-[10px] text-muted-foreground mt-2">{t("researchSourcesDesc")}</p>
      </SettingsGroup>
    </div>
  )
}
