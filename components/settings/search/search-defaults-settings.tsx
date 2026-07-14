"use client"

import { useRef } from "react"
import { useTranslations } from "next-intl"
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { SettingsGrid, SettingsToggle } from "@/components/settings/common/settings-section"
import { useSettingsStore } from "@/stores/settings"
import type { SearchType, SearchDepth, SearchRecency } from "@cognia/web-search/types"
import { createLogger } from "@cognia/logging"
import { DomainListInput } from "./_shared/domain-list-input"
import { SegmentedControl, type SegmentedOption } from "./_shared/segmented-control"

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

  const typeOptions: SegmentedOption<SearchType>[] = SEARCH_TYPES.map((t) => ({
    value: t.value,
    label: td(t.labelKey),
  }))
  const depthOptions: SegmentedOption<SearchDepth>[] = SEARCH_DEPTHS.map((d) => ({
    value: d.value,
    label: td(d.labelKey),
    description: td(d.descKey),
  }))

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label className="text-sm">{td("searchType")}</Label>
        <SegmentedControl
          variant="inline"
          value={defaultSearchType}
          onValueChange={(v) => {
            log.info("default_type_changed", { type: v })
            void setDefaultSearchType(v)
          }}
          options={typeOptions}
          aria-label={td("searchType")}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label className="text-sm">{td("searchDepth")}</Label>
          <SegmentedControl
            variant="cards"
            value={defaultSearchDepth}
            onValueChange={(v) => {
              log.info("default_depth_changed", { depth: v })
              void setDefaultSearchDepth(v)
            }}
            options={depthOptions}
            className="sm:grid-cols-1"
            aria-label={td("searchDepth")}
          />
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

      <SettingsGrid columns={2}>
        <SettingsToggle
          id="search-default-include-answer"
          label={td("includeAnswer")}
          checked={defaultIncludeAnswer}
          onCheckedChange={(v) => {
            log.info("include_answer_changed", { enabled: v })
            void setDefaultIncludeAnswer(v)
          }}
        />
        <SettingsToggle
          id="search-default-include-raw"
          label={td("includeRawContent")}
          checked={defaultIncludeRawContent}
          onCheckedChange={(v) => {
            log.info("include_raw_content_changed", { enabled: v })
            void setDefaultIncludeRawContent(v)
          }}
        />
      </SettingsGrid>
    </div>
  )
}
