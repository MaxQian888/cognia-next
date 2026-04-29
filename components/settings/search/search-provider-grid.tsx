"use client"

import { useState, useCallback, useMemo } from "react"
import { useTranslations } from "next-intl"
import { Search, CheckSquare, Square, RotateCcw, Filter } from "lucide-react"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuCheckboxItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useSettingsStore } from "@/stores/settings-store"
import {
  type SearchProviderType,
  SEARCH_PROVIDERS,
  isProviderConfigured,
  DEFAULT_SEARCH_PROVIDER_SETTINGS,
} from "@/lib/search/types"
import { testProviderConnection } from "@/lib/search/provider-test"
import { SearchProviderCard, type ProviderTestState } from "./search-provider-card"

const ALL_PROVIDER_IDS = Object.keys(SEARCH_PROVIDERS) as SearchProviderType[]

const FEATURE_FILTERS = [
  { key: "aiAnswer", labelKey: "features.aiAnswer" },
  { key: "newsSearch", labelKey: "features.news" },
  { key: "imageSearch", labelKey: "features.images" },
  { key: "academicSearch", labelKey: "features.academic" },
  { key: "contentExtraction", labelKey: "features.contentExtraction" },
] as const

export function SearchProviderGrid() {
  const t = useTranslations("searchSettings")
  const [searchQuery, setSearchQuery] = useState("")
  const [featureFilters, setFeatureFilters] = useState<string[]>([])
  const [expandedProviders, setExpandedProviders] = useState<Record<SearchProviderType, boolean>>(
    () =>
      Object.fromEntries(ALL_PROVIDER_IDS.map((id) => [id, false])) as Record<
        SearchProviderType,
        boolean
      >
  )
  const [showKeys, setShowKeys] = useState<Record<SearchProviderType, boolean>>(
    () =>
      Object.fromEntries(ALL_PROVIDER_IDS.map((id) => [id, false])) as Record<
        SearchProviderType,
        boolean
      >
  )
  const [testStates, setTestStates] = useState<Record<SearchProviderType, ProviderTestState>>(
    () =>
      Object.fromEntries(
        ALL_PROVIDER_IDS.map((id) => [id, { testing: false, result: null }])
      ) as Record<SearchProviderType, ProviderTestState>
  )

  const searchProviders = useSettingsStore(
    (s) => s.settings?.searchProviders ?? DEFAULT_SEARCH_PROVIDER_SETTINGS
  )
  const setSearchProviderEnabled = useSettingsStore((s) => s.setSearchProviderEnabled)

  const enabledCount = Object.values(searchProviders).filter(
    (p) => p.enabled && isProviderConfigured(p.providerId, p)
  ).length

  const filteredProviders = useMemo(() => {
    let list = ALL_PROVIDER_IDS
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase()
      list = list.filter(
        (id) =>
          SEARCH_PROVIDERS[id].name.toLowerCase().includes(q) ||
          SEARCH_PROVIDERS[id].description.toLowerCase().includes(q)
      )
    }
    if (featureFilters.length > 0) {
      list = list.filter((id) => {
        const features = SEARCH_PROVIDERS[id].features
        return featureFilters.every((f) => features[f as keyof typeof features])
      })
    }
    return list
  }, [searchQuery, featureFilters])

  const toggleExpand = useCallback((id: SearchProviderType) => {
    setExpandedProviders((prev) => ({ ...prev, [id]: !prev[id] }))
  }, [])

  const toggleKey = useCallback((id: SearchProviderType) => {
    setShowKeys((prev) => ({ ...prev, [id]: !prev[id] }))
  }, [])

  const handleTestConnection = useCallback(
    async (providerId: SearchProviderType) => {
      const apiKey = searchProviders[providerId]?.apiKey
      if (!apiKey) return
      setTestStates((prev) => ({
        ...prev,
        [providerId]: { testing: true, result: null },
      }))
      try {
        const isValid = await testProviderConnection(
          providerId,
          apiKey,
          providerId === "google" ? { cx: searchProviders[providerId]?.cx } : undefined
        )
        setTestStates((prev) => ({
          ...prev,
          [providerId]: { testing: false, result: isValid ? "success" : "error" },
        }))
      } catch {
        setTestStates((prev) => ({
          ...prev,
          [providerId]: { testing: false, result: "error" },
        }))
      }
    },
    [searchProviders]
  )

  const enableAll = () => {
    filteredProviders.forEach((id) => {
      if (isProviderConfigured(id, searchProviders[id])) {
        void setSearchProviderEnabled(id, true)
      }
    })
  }

  const disableAll = () => {
    filteredProviders.forEach((id) => void setSearchProviderEnabled(id, false))
  }

  const resetToDefaults = () => {
    ALL_PROVIDER_IDS.forEach((id) => {
      void setSearchProviderEnabled(id, false)
    })
    setSearchQuery("")
    setFeatureFilters([])
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-base">{t("providers")}</CardTitle>
          <Badge variant="secondary" className="text-[10px]">
            {enabledCount}/{ALL_PROVIDER_IDS.length} {t("enabled")}
          </Badge>
        </div>
        <CardDescription className="text-xs">{t("providersDescription")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center gap-2 flex-wrap">
          <div className="relative flex-1 min-w-[150px]">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              placeholder={t("filterProviders")}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="h-8 pl-8 text-xs"
            />
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="h-8 text-xs">
                <Filter className="h-3 w-3 mr-1" />
                {t("features")}
                {featureFilters.length > 0 && (
                  <Badge variant="secondary" className="ml-1 text-[10px] px-1 py-0">
                    {featureFilters.length}
                  </Badge>
                )}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {FEATURE_FILTERS.map((f) => (
                <DropdownMenuCheckboxItem
                  key={f.key}
                  checked={featureFilters.includes(f.key)}
                  onCheckedChange={(checked) => {
                    if (checked) {
                      setFeatureFilters([...featureFilters, f.key])
                    } else {
                      setFeatureFilters(featureFilters.filter((x) => x !== f.key))
                    }
                  }}
                  className="text-xs"
                >
                  {t(f.labelKey)}
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <Button variant="ghost" size="sm" className="h-8 text-xs" onClick={enableAll}>
            <CheckSquare className="h-3 w-3 mr-1" />
            {t("enableAll")}
          </Button>
          <Button variant="ghost" size="sm" className="h-8 text-xs" onClick={disableAll}>
            <Square className="h-3 w-3 mr-1" />
            {t("disableAll")}
          </Button>
          <Button variant="ghost" size="sm" className="h-8 text-xs" onClick={resetToDefaults}>
            <RotateCcw className="h-3 w-3 mr-1" />
            {t("reset")}
          </Button>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          {filteredProviders.map((providerId) => (
            <SearchProviderCard
              key={providerId}
              providerId={providerId}
              isExpanded={expandedProviders[providerId]}
              showKey={showKeys[providerId]}
              testState={testStates[providerId]}
              onToggleExpand={() => toggleExpand(providerId)}
              onToggleKey={() => toggleKey(providerId)}
              onTestConnection={() => handleTestConnection(providerId)}
            />
          ))}
          {filteredProviders.length === 0 && (
            <div className="col-span-full py-8 text-center text-xs text-muted-foreground">
              {t("noMatchingProviders")}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
