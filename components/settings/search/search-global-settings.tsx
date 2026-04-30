"use client"

import { useState } from "react"
import { useTranslations } from "next-intl"
import { Search, Globe, ChevronRight, Plus } from "lucide-react"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Slider } from "@/components/ui/slider"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
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
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { useSettingsStore } from "@/stores/settings"
import {
  type SearchProviderType,
  SEARCH_PROVIDERS,
  isProviderConfigured,
  DEFAULT_SEARCH_PROVIDER_SETTINGS,
} from "@/lib/search/types"
import { SEARCH_SOURCES } from "@/lib/search/search-constants"
import { cn } from "@/lib/utils"
import { createLogger } from "@/lib/logger"
import { SourcePill } from "./_shared/source-pill"

const log = createLogger("settings.search.global")

export function SearchGlobalSettings() {
  const t = useTranslations("searchSettings")

  const settings = useSettingsStore((s) => s.settings)
  const setSearchEnabled = useSettingsStore((s) => s.setSearchEnabled)
  const setSearchMaxResults = useSettingsStore((s) => s.setSearchMaxResults)
  const setSearchFallbackEnabled = useSettingsStore((s) => s.setSearchFallbackEnabled)
  const setDefaultSearchProvider = useSettingsStore((s) => s.setDefaultSearchProvider)
  const setDefaultSearchSources = useSettingsStore((s) => s.setDefaultSearchSources)
  const addCustomSearchSource = useSettingsStore((s) => s.addCustomSearchSource)
  const removeCustomSearchSource = useSettingsStore((s) => s.removeCustomSearchSource)

  const searchEnabled = settings?.searchEnabled ?? false
  const searchMaxResults = settings?.searchMaxResults ?? 5
  const searchFallbackEnabled = settings?.searchFallbackEnabled ?? true
  const defaultSearchProvider: SearchProviderType = settings?.defaultSearchProvider ?? "tavily"
  const defaultSearchSources = settings?.defaultSearchSources ?? []
  const searchProviders = settings?.searchProviders ?? DEFAULT_SEARCH_PROVIDER_SETTINGS
  const customSearchSources = settings?.customSearchSources ?? []

  const [sourcesExpanded, setSourcesExpanded] = useState(false)
  const [newSourceName, setNewSourceName] = useState("")
  const [addSourceOpen, setAddSourceOpen] = useState(false)

  const enabledCount = Object.values(searchProviders).filter(
    (p) => p.enabled && isProviderConfigured(p.providerId, p)
  ).length

  const providerIds = Object.keys(SEARCH_PROVIDERS) as SearchProviderType[]
  const configuredProviders = providerIds.filter((id) => {
    const s = searchProviders[id]
    return !!s?.enabled && isProviderConfigured(id, s)
  })

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
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center gap-2">
          <Search className="h-4 w-4 text-muted-foreground" />
          <div>
            <CardTitle className="text-base">{t("title")}</CardTitle>
            <CardDescription className="text-xs">{t("description")}</CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <div className="flex items-center justify-between rounded-md border px-3 py-2">
            <Label className="text-xs">{t("enableSearch")}</Label>
            <Switch
              checked={searchEnabled}
              onCheckedChange={(v) => {
                log.info("search_enabled_changed", { enabled: v })
                void setSearchEnabled(v)
              }}
              disabled={enabledCount === 0}
            />
          </div>
          <div className="flex items-center justify-between rounded-md border px-3 py-2">
            <Label className="text-xs">{t("fallbackEnabled")}</Label>
            <Switch
              checked={searchFallbackEnabled}
              onCheckedChange={(v) => {
                log.info("fallback_changed", { enabled: v })
                void setSearchFallbackEnabled(v)
              }}
              disabled={!searchEnabled}
            />
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
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
            {configuredProviders.length === 0 && (
              <p className="text-xs text-muted-foreground">{t("configureProviderHint")}</p>
            )}
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
        </div>

        {/* Research Sources */}
        <Collapsible open={sourcesExpanded} onOpenChange={setSourcesExpanded}>
          <CollapsibleTrigger asChild>
            <button className="flex items-center justify-between w-full rounded-md border px-3 py-2 hover:bg-muted/50 transition-colors">
              <div className="flex items-center gap-2">
                <Globe className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="text-xs font-medium">{t("researchSources")}</span>
                <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                  {defaultSearchSources.length + customSearchSources.length} {t("selected")}
                </Badge>
              </div>
              <ChevronRight
                className={cn(
                  "h-3.5 w-3.5 text-muted-foreground transition-transform",
                  sourcesExpanded && "rotate-90"
                )}
              />
            </button>
          </CollapsibleTrigger>
          <CollapsibleContent className="pt-3">
            <div className="flex flex-wrap gap-2">
              {SEARCH_SOURCES.map((source) => {
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
                  />
                )
              })}
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
                  <button
                    disabled={!searchEnabled}
                    className={cn(
                      "inline-flex items-center gap-1 rounded-full px-3 py-1.5 text-xs font-medium border border-dashed transition-colors",
                      searchEnabled
                        ? "cursor-pointer hover:bg-muted/50 text-muted-foreground"
                        : "opacity-50 cursor-not-allowed text-muted-foreground"
                    )}
                  >
                    <Plus className="h-3 w-3" />
                    <span>{t("addCustomSource")}</span>
                  </button>
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
          </CollapsibleContent>
        </Collapsible>
      </CardContent>
    </Card>
  )
}
