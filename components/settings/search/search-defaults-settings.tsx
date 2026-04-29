"use client"

import { useState } from "react"
import { useTranslations } from "next-intl"
import { Sliders, X } from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { useSettingsStore } from "@/stores/settings-store"
import type { SearchType, SearchDepth, SearchRecency } from "@/lib/search/types"
import { cn } from "@/lib/utils"

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

  const [includeDomainInput, setIncludeDomainInput] = useState("")
  const [excludeDomainInput, setExcludeDomainInput] = useState("")

  const handleAddIncludeDomain = () => {
    const d = includeDomainInput.trim().toLowerCase()
    if (d && !defaultIncludeDomains.includes(d)) {
      void setDefaultIncludeDomains([...defaultIncludeDomains, d])
      setIncludeDomainInput("")
    }
  }

  const handleAddExcludeDomain = () => {
    const d = excludeDomainInput.trim().toLowerCase()
    if (d && !defaultExcludeDomains.includes(d)) {
      void setDefaultExcludeDomains([...defaultExcludeDomains, d])
      setExcludeDomainInput("")
    }
  }

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
                onClick={() => void setDefaultSearchType(type.value)}
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
                  onClick={() => void setDefaultSearchDepth(depth.value)}
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
              onValueChange={(v) => void setDefaultSearchRecency(v as SearchRecency)}
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

        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label className="text-sm">{td("country")}</Label>
            <Input
              placeholder={td("countryPlaceholder")}
              value={defaultSearchCountry}
              onChange={(e) => void setDefaultSearchCountry(e.target.value)}
              className="h-8 text-sm"
            />
          </div>
          <div className="space-y-2">
            <Label className="text-sm">{td("language")}</Label>
            <Input
              placeholder={td("languagePlaceholder")}
              value={defaultSearchLanguage}
              onChange={(e) => void setDefaultSearchLanguage(e.target.value)}
              className="h-8 text-sm"
            />
          </div>
        </div>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label className="text-sm">{td("includeDomains")}</Label>
            <div className="flex gap-2">
              <Input
                placeholder={td("includeDomainsPlaceholder")}
                value={includeDomainInput}
                onChange={(e) => setIncludeDomainInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleAddIncludeDomain()}
                className="h-8 text-sm"
              />
            </div>
            {defaultIncludeDomains.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-1">
                {defaultIncludeDomains.map((d) => (
                  <Badge key={d} variant="secondary" className="text-xs gap-1">
                    {d}
                    <button
                      onClick={() =>
                        void setDefaultIncludeDomains(defaultIncludeDomains.filter((x) => x !== d))
                      }
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </Badge>
                ))}
              </div>
            )}
          </div>

          <div className="space-y-1.5">
            <Label className="text-sm">{td("excludeDomains")}</Label>
            <div className="flex gap-2">
              <Input
                placeholder={td("excludeDomainsPlaceholder")}
                value={excludeDomainInput}
                onChange={(e) => setExcludeDomainInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleAddExcludeDomain()}
                className="h-8 text-sm"
              />
            </div>
            {defaultExcludeDomains.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-1">
                {defaultExcludeDomains.map((d) => (
                  <Badge key={d} variant="secondary" className="text-xs gap-1">
                    {d}
                    <button
                      onClick={() =>
                        void setDefaultExcludeDomains(defaultExcludeDomains.filter((x) => x !== d))
                      }
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </Badge>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <div className="flex items-center justify-between rounded-md border px-3 py-2">
            <Label className="text-xs">{td("includeAnswer")}</Label>
            <Switch
              checked={defaultIncludeAnswer}
              onCheckedChange={(v) => void setDefaultIncludeAnswer(v)}
            />
          </div>
          <div className="flex items-center justify-between rounded-md border px-3 py-2">
            <Label className="text-xs">{td("includeRawContent")}</Label>
            <Switch
              checked={defaultIncludeRawContent}
              onCheckedChange={(v) => void setDefaultIncludeRawContent(v)}
            />
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
