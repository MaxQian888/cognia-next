"use client"

import { useState } from "react"
import { useTranslations } from "next-intl"
import { ChevronDown, ChevronUp } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { providerSupportsType } from "@cognia/web-search/search-type-router"
import {
  SEARCH_PROVIDERS,
  type SearchProviderSettings,
  type SearchProviderType,
} from "@cognia/web-search/types"

/**
 * Per-provider `defaultOptions` editor. Every field offers an "Inherit global"
 * choice which deletes the key; once no override remains the card persists
 * `undefined` so the provider falls back to the global defaults entirely.
 * Search-type choices are filtered to what the provider actually supports.
 */

const INHERIT = "__inherit__"

type ProviderDefaultOptions = NonNullable<SearchProviderSettings["defaultOptions"]>

const SEARCH_TYPES = ["general", "news", "academic", "images", "videos"] as const
const SEARCH_DEPTHS = ["basic", "advanced", "deep"] as const
const RECENCIES = ["any", "day", "week", "month", "year"] as const
const MAX_RESULTS_LIMIT = 50

export interface ProviderDefaultsEditorProps {
  providerId: SearchProviderType
  value: SearchProviderSettings["defaultOptions"]
  onChange: (next: SearchProviderSettings["defaultOptions"] | undefined) => void
  idPrefix?: string
}

export function ProviderDefaultsEditor({
  providerId,
  value,
  onChange,
  idPrefix = `${providerId}-defaults`,
}: ProviderDefaultsEditorProps) {
  const t = useTranslations("searchSettings")
  const td = useTranslations("searchDefaults")
  const [open, setOpen] = useState(false)

  const features = SEARCH_PROVIDERS[providerId].features
  const supportedTypes = SEARCH_TYPES.filter((type) => providerSupportsType(providerId, type))
  const overrideCount = Object.values(value ?? {}).filter((v) => v !== undefined).length

  const update = (patch: Partial<ProviderDefaultOptions>) => {
    const next: ProviderDefaultOptions = { ...value, ...patch }
    for (const key of Object.keys(next) as (keyof ProviderDefaultOptions)[]) {
      if (next[key] === undefined) delete next[key]
    }
    onChange(Object.keys(next).length > 0 ? next : undefined)
  }

  const commitMaxResults = (raw: string) => {
    const trimmed = raw.trim()
    if (trimmed === "") {
      update({ maxResults: undefined })
      return
    }
    const parsed = Number(trimmed)
    if (!Number.isFinite(parsed)) return
    update({ maxResults: Math.max(1, Math.min(MAX_RESULTS_LIMIT, Math.round(parsed))) })
  }

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className="flex w-full items-center justify-between text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          <span className="flex items-center gap-1.5">
            {t("overrides.title")}
            {overrideCount > 0 && (
              <Badge variant="secondary" className="text-[10px] px-1 py-0">
                {t("overrides.count", { count: overrideCount })}
              </Badge>
            )}
          </span>
          {open ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="space-y-2 pt-2">
          <p className="text-[10px] text-muted-foreground">{t("overrides.description")}</p>

          <div className="grid grid-cols-2 gap-2">
            {/* searchType — only types the provider supports */}
            <div className="space-y-1">
              <Label htmlFor={`${idPrefix}-search-type`} className="text-xs">
                {td("searchType")}
              </Label>
              <Select
                value={value?.searchType ?? INHERIT}
                onValueChange={(v) =>
                  update({
                    searchType:
                      v === INHERIT ? undefined : (v as ProviderDefaultOptions["searchType"]),
                  })
                }
              >
                <SelectTrigger id={`${idPrefix}-search-type`} className="h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={INHERIT} className="text-xs">
                    {t("overrides.inherit")}
                  </SelectItem>
                  {supportedTypes.map((type) => (
                    <SelectItem key={type} value={type} className="text-xs">
                      {td(type)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* searchDepth */}
            <div className="space-y-1">
              <Label htmlFor={`${idPrefix}-search-depth`} className="text-xs">
                {td("searchDepth")}
              </Label>
              <Select
                value={value?.searchDepth ?? INHERIT}
                onValueChange={(v) =>
                  update({
                    searchDepth:
                      v === INHERIT ? undefined : (v as ProviderDefaultOptions["searchDepth"]),
                  })
                }
              >
                <SelectTrigger id={`${idPrefix}-search-depth`} className="h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={INHERIT} className="text-xs">
                    {t("overrides.inherit")}
                  </SelectItem>
                  {SEARCH_DEPTHS.map((depth) => (
                    <SelectItem key={depth} value={depth} className="text-xs">
                      {td(depth)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* recency — only providers with a recency filter */}
            {features.recencyFilter && (
              <div className="space-y-1">
                <Label htmlFor={`${idPrefix}-recency`} className="text-xs">
                  {td("recency")}
                </Label>
                <Select
                  value={value?.recency ?? INHERIT}
                  onValueChange={(v) =>
                    update({
                      recency:
                        v === INHERIT ? undefined : (v as ProviderDefaultOptions["recency"]),
                    })
                  }
                >
                  <SelectTrigger id={`${idPrefix}-recency`} className="h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={INHERIT} className="text-xs">
                      {t("overrides.inherit")}
                    </SelectItem>
                    {RECENCIES.map((recency) => (
                      <SelectItem key={recency} value={recency} className="text-xs">
                        {td(recency)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            {/* includeAnswer — only providers that can synthesize one */}
            {features.aiAnswer && (
              <div className="space-y-1">
                <Label htmlFor={`${idPrefix}-include-answer`} className="text-xs">
                  {td("includeAnswer")}
                </Label>
                <Select
                  value={
                    value?.includeAnswer === undefined
                      ? INHERIT
                      : value.includeAnswer
                        ? "on"
                        : "off"
                  }
                  onValueChange={(v) =>
                    update({
                      includeAnswer: v === INHERIT ? undefined : v === "on",
                    })
                  }
                >
                  <SelectTrigger id={`${idPrefix}-include-answer`} className="h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={INHERIT} className="text-xs">
                      {t("overrides.inherit")}
                    </SelectItem>
                    <SelectItem value="on" className="text-xs">
                      {t("overrides.on")}
                    </SelectItem>
                    <SelectItem value="off" className="text-xs">
                      {t("overrides.off")}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>

          {/* maxResults — blank means inherit; committed (clamped) on blur */}
          <div className="space-y-1">
            <Label htmlFor={`${idPrefix}-max-results`} className="text-xs">
              {t("overrides.maxResults")}
            </Label>
            <Input
              id={`${idPrefix}-max-results`}
              // `key` remounts the uncontrolled input when the persisted value
              // changes externally (e.g. a settings sync), keeping it in sync
              // without a set-state-in-effect.
              key={value?.maxResults ?? "inherit"}
              type="number"
              min={1}
              max={MAX_RESULTS_LIMIT}
              defaultValue={value?.maxResults ?? ""}
              placeholder={t("overrides.inherit")}
              onBlur={(e) => commitMaxResults(e.target.value)}
              className="h-8 text-xs"
            />
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}
