"use client"

import { useRef } from "react"
import { useTranslations } from "next-intl"
import { Sliders } from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { useSettingsStore } from "@/stores/settings"
import type { SearchType, SearchDepth, SearchRecency } from "@/lib/search/types"
import { cn } from "@/lib/utils"
import { createLogger } from "@/lib/logging"
import { DomainListInput } from "./_shared/domain-list-input"

const log = createLogger("settings.search.defaults")

const SEARCH_TYPES: { value: SearchType; labelKey: string }[] = [
  { value: "general", labelKey: "general" },
  { value: "news", labelKey: "news" },
  { value: "academic", labelKey: "academic" },
  { value: "images", labelKey: "images" },
  { value: "videos", labelKey: "videos" },
]

const SEARCH_DEPTHS: { value: SearchDepth; labelKey: string; descKey: string }[] = [
  { value: "basic", labelKey: "basic", descKey: "basicDesc" },
  { value: "advanced", labelKey: "advanced", descKey: "advancedDesc" },
  { value: "deep", labelKey: "deep", descKey: "deepDesc" },
]

const RECENCY_OPTIONS: { value: SearchRecency; labelKey: string }[] = [
  { value: "any", labelKey: "any" },
  { value: "day", labelKey: "day" },
  { value: "week", labelKey: "week" },
  { value: "month", labelKey: "month" },
  { value: "year", labelKey: "year" },
]

export function SearchDefaultsSettings() {
  const td = useTranslations("searchDefaults")

  const settings = useSettingsStore((s) => s.settings)
  const setDefaultSearchType = useSettingsStore((s) => s.setDefaultSearchType)
  const setDefaultSearchDepth = useSettingsStore((s) => s.setDefaultSearchDepth)
  const setDefaultSearchRecency = useSettingsStore((s) => s.setDefaultSearchRecency)
  const setDefaultSearchCountry = useSettingsStore((s) => s.setDefaultSearchCountry)
  const setDefaultSearchLanguage = useSettingsStore((s) => s.setDefaultSearchLanguage)
  const setDefaultIncludeDomains = useSettingsStore((s) => s.setDefaultIncludeDomains)
  const setDefaultExcludeDomains = useSettingsStore((s) => s.setDefaultExcludeDomains)
  const setDefaultIncludeAnswer = useSettingsStore((s) => s.setDefaultIncludeAnswer)
  const setDefaultIncludeRawContent = useSettingsStore((s) => s.setDefaultIncludeRawContent)

  const defaultSearchType = settings?.defaultSearchType ?? "general"
  const defaultSearchDepth = settings?.defaultSearchDepth ?? "basic"
  const defaultSearchRecency = settings?.defaultSearchRecency ?? "any"
  const defaultSearchCountry = settings?.defaultSearchCountry ?? ""
  const defaultSearchLanguage = settings?.defaultSearchLanguage ?? "en"
  const defaultIncludeDomains = settings?.defaultIncludeDomains ?? []
  const defaultExcludeDomains = settings?.defaultExcludeDomains ?? []
  const defaultIncludeAnswer = settings?.defaultIncludeAnswer ?? true
  const defaultIncludeRawContent = settings?.defaultIncludeRawContent ?? false

  const lastLoggedCountry = useRef(defaultSearchCountry)
  const lastLoggedLanguage = useRef(defaultSearchLanguage)

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center gap-2">
          <Sliders className="h-4 w-4 text-muted-foreground" />
          <div>
            <CardTitle className="text-base">{td("title")}</CardTitle>
            <CardDescription className="text-xs">{td("description")}</CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label className="text-sm">{td("searchType")}</Label>
          <div className="flex flex-wrap gap-1">
            {SEARCH_TYPES.map((type) => (
              <button
                key={type.value}
                onClick={() => {
                  log.info("default_type_changed", { type: type.value })
                  void setDefaultSearchType(type.value)
                }}
                className={cn(
                  "px-3 py-1.5 rounded-md text-xs font-medium transition-colors border",
                  defaultSearchType === type.value
                    ? "bg-primary text-primary-foreground border-primary"
                    : "bg-muted hover:bg-muted/80 border-border"
                )}
              >
                {td(type.labelKey)}
              </button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label className="text-sm">{td("searchDepth")}</Label>
            <div className="space-y-1.5">
              {SEARCH_DEPTHS.map((depth) => (
                <button
                  key={depth.value}
                  onClick={() => {
                    log.info("default_depth_changed", { depth: depth.value })
                    void setDefaultSearchDepth(depth.value)
                  }}
                  className={cn(
                    "w-full flex items-start gap-2 p-2.5 rounded-md border text-left transition-colors",
                    defaultSearchDepth === depth.value
                      ? "border-primary bg-primary/5"
                      : "border-border hover:border-primary/50"
                  )}
                >
                  <span
                    className={cn(
                      "h-3.5 w-3.5 rounded-full border-2 mt-0.5 shrink-0",
                      defaultSearchDepth === depth.value
                        ? "border-primary bg-primary"
                        : "border-muted-foreground/30"
                    )}
                  />
                  <div>
                    <span className="text-xs font-medium">{td(depth.labelKey)}</span>
                    <p className="text-[10px] text-muted-foreground">{td(depth.descKey)}</p>
                  </div>
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-2">
            <Label className="text-sm">{td("recency")}</Label>
            <Select
              value={defaultSearchRecency}
              onValueChange={(v) => {
                log.info("default_recency_changed", { recency: v })
                void setDefaultSearchRecency(v as SearchRecency)
              }}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {RECENCY_OPTIONS.map((r) => (
                  <SelectItem key={r.value} value={r.value} className="text-xs">
                    {td(r.labelKey)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label className="text-sm">{td("country")}</Label>
            <Input
              placeholder={td("countryPlaceholder")}
              value={defaultSearchCountry}
              onChange={(e) => void setDefaultSearchCountry(e.target.value)}
              onBlur={(e) => {
                if (e.target.value !== lastLoggedCountry.current) {
                  log.info("default_country_changed", { value: e.target.value })
                  lastLoggedCountry.current = e.target.value
                }
              }}
              className="h-8 text-sm"
            />
          </div>
          <div className="space-y-2">
            <Label className="text-sm">{td("language")}</Label>
            <Input
              placeholder={td("languagePlaceholder")}
              value={defaultSearchLanguage}
              onChange={(e) => void setDefaultSearchLanguage(e.target.value)}
              onBlur={(e) => {
                if (e.target.value !== lastLoggedLanguage.current) {
                  log.info("default_language_changed", { value: e.target.value })
                  lastLoggedLanguage.current = e.target.value
                }
              }}
              className="h-8 text-sm"
            />
          </div>
        </div>

        <div className="space-y-3">
          <DomainListInput
            label={td("includeDomains")}
            placeholder={td("includeDomainsPlaceholder")}
            domains={defaultIncludeDomains}
            onAdd={(raw) => {
              const d = raw.toLowerCase()
              if (defaultIncludeDomains.includes(d)) return
              log.info("include_domain_added", { domain: d })
              void setDefaultIncludeDomains([...defaultIncludeDomains, d])
            }}
            onRemove={(d) => {
              log.info("include_domain_removed", { domain: d })
              void setDefaultIncludeDomains(defaultIncludeDomains.filter((x) => x !== d))
            }}
          />

          <DomainListInput
            label={td("excludeDomains")}
            placeholder={td("excludeDomainsPlaceholder")}
            domains={defaultExcludeDomains}
            onAdd={(raw) => {
              const d = raw.toLowerCase()
              if (defaultExcludeDomains.includes(d)) return
              log.info("exclude_domain_added", { domain: d })
              void setDefaultExcludeDomains([...defaultExcludeDomains, d])
            }}
            onRemove={(d) => {
              log.info("exclude_domain_removed", { domain: d })
              void setDefaultExcludeDomains(defaultExcludeDomains.filter((x) => x !== d))
            }}
          />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <div className="flex items-center justify-between rounded-md border px-3 py-2">
            <Label className="text-xs">{td("includeAnswer")}</Label>
            <Switch
              checked={defaultIncludeAnswer}
              onCheckedChange={(v) => {
                log.info("include_answer_changed", { enabled: v })
                void setDefaultIncludeAnswer(v)
              }}
            />
          </div>
          <div className="flex items-center justify-between rounded-md border px-3 py-2">
            <Label className="text-xs">{td("includeRawContent")}</Label>
            <Switch
              checked={defaultIncludeRawContent}
              onCheckedChange={(v) => {
                log.info("include_raw_content_changed", { enabled: v })
                void setDefaultIncludeRawContent(v)
              }}
            />
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
