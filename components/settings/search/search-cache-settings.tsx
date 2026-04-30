"use client"

import { useState, useCallback } from "react"
import { useTranslations } from "next-intl"
import { Database, Trash2 } from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Slider } from "@/components/ui/slider"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { useSettingsStore } from "@/stores/settings"
import { getSearchCache } from "@/lib/search/search-cache"
import { DEFAULT_SEARCH_PROVIDER_SETTINGS } from "@/lib/search/types"
import { createLogger } from "@/lib/logger"

const log = createLogger("settings.search.cache")

export function SearchCacheSettings() {
  const tc = useTranslations("searchCache")
  const [stats, setStats] = useState(() => getSearchCache().getStats())
  const [selectedProvider, setSelectedProvider] = useState<string>("all")

  const settings = useSettingsStore((s) => s.settings)
  const setSearchCacheEnabled = useSettingsStore((s) => s.setSearchCacheEnabled)
  const setSearchCacheTTL = useSettingsStore((s) => s.setSearchCacheTTL)
  const setSearchCacheMaxEntries = useSettingsStore((s) => s.setSearchCacheMaxEntries)

  const searchCacheEnabled = settings?.searchCacheEnabled ?? true
  const searchCacheTTL = settings?.searchCacheTTL ?? 600_000
  const searchCacheMaxEntries = settings?.searchCacheMaxEntries ?? 500
  const searchProviders = settings?.searchProviders ?? DEFAULT_SEARCH_PROVIDER_SETTINGS

  const refreshStats = useCallback(() => {
    setStats(getSearchCache().getStats())
  }, [])

  const handleClearCache = useCallback(() => {
    const sizeBefore = getSearchCache().getStats().size
    if (selectedProvider === "all") {
      getSearchCache().clear()
    } else {
      getSearchCache().invalidate(`search:${selectedProvider}`)
    }
    log.info("cache_cleared", { provider: selectedProvider, sizeBefore })
    refreshStats()
  }, [selectedProvider, refreshStats])

  const handleTTLChange = useCallback(
    ([value]: number[]) => {
      void setSearchCacheTTL(value)
      getSearchCache().setConfig({ defaultTTL: value })
    },
    [setSearchCacheTTL]
  )

  const handleMaxEntriesChange = useCallback(
    ([value]: number[]) => {
      void setSearchCacheMaxEntries(value)
      getSearchCache().setConfig({ maxSize: value })
    },
    [setSearchCacheMaxEntries]
  )

  // searchCacheTTL is stored in milliseconds.
  const ttlMinutes = Math.round(searchCacheTTL / 60_000)
  const hitRatePercent = Math.round(stats.hitRate * 100)

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Database className="h-4 w-4 text-muted-foreground" />
            <div>
              <CardTitle className="text-base">{tc("title")}</CardTitle>
              <CardDescription className="text-xs">{tc("description")}</CardDescription>
            </div>
          </div>
          <Switch
            checked={searchCacheEnabled}
            onCheckedChange={(v) => {
              log.info("cache_enabled_changed", { enabled: v })
              void setSearchCacheEnabled(v)
            }}
          />
        </div>
      </CardHeader>
      {searchCacheEnabled && (
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label className="text-sm">
              {tc("ttl")}: {ttlMinutes} min
            </Label>
            <Slider
              value={[searchCacheTTL]}
              onValueChange={handleTTLChange}
              onValueCommit={([value]) => log.info("cache_ttl_changed", { ttlMs: value })}
              min={60_000}
              max={3_600_000}
              step={60_000}
            />
          </div>

          <div className="space-y-2">
            <Label className="text-sm">
              {tc("maxEntries")}: {searchCacheMaxEntries}
            </Label>
            <Slider
              value={[searchCacheMaxEntries]}
              onValueChange={handleMaxEntriesChange}
              onValueCommit={([value]) =>
                log.info("cache_max_entries_changed", { maxEntries: value })
              }
              min={100}
              max={2000}
              step={100}
            />
          </div>

          <div className="rounded-md border p-3 space-y-2">
            <div className="flex items-center justify-between text-xs">
              <span className="text-muted-foreground">{tc("hitRate")}</span>
              <Badge variant="outline" className="text-xs">
                {hitRatePercent}%
              </Badge>
            </div>
            <Progress value={hitRatePercent} className="h-1.5" />
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>
                {tc("entries")}: {stats.size}/{stats.maxSize}
              </span>
              <span>
                {tc("hits")}: {stats.hits} / {tc("misses")}: {stats.misses}
              </span>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Select value={selectedProvider} onValueChange={setSelectedProvider}>
              <SelectTrigger className="h-8 text-xs w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all" className="text-xs">
                  {tc("allProviders")}
                </SelectItem>
                {Object.keys(searchProviders).map((p) => (
                  <SelectItem key={p} value={p} className="text-xs capitalize">
                    {p}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button variant="outline" size="sm" onClick={handleClearCache} className="text-xs">
              <Trash2 className="h-3.5 w-3.5 mr-1" />
              {tc("clearCache")}
            </Button>
          </div>
        </CardContent>
      )}
    </Card>
  )
}
