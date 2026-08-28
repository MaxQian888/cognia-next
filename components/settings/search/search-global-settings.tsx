"use client"

import { useState } from "react"
import { useTranslations } from "next-intl"
import { Globe, Plus, AlertCircle } from "lucide-react"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Slider } from "@/components/ui/slider"
import { Badge } from "@/components/ui/badge"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import {
  Select,
  SelectContent,
  SelectGroup,
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
import { cn } from "@/lib/utils"
import { createLogger } from "@cognia/logging"
import { SourcePill } from "./_shared/source-pill"
import { normalizeSearchDomain, SEARCH_SOURCES } from "@cognia/web-search/search-constants"

const log = createLogger("settings.search.global")

interface DomainSearchSource {
  id: string
  name: string
  domain?: string
  icon?: string
}

const BUILT_IN_DOMAIN_SOURCES = SEARCH_SOURCES.filter((source) => source.kind === "domain").map(
  (source) => ({ ...source, nameKey: `domainSources.${source.id}` })
)

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
  const customSearchSources = (settings?.customSearchSources ?? []) as DomainSearchSource[]

  const [newSourceName, setNewSourceName] = useState("")
  const [newSourceDomain, setNewSourceDomain] = useState("")
  const [sourceDomainInvalid, setSourceDomainInvalid] = useState(false)
  const [addSourceOpen, setAddSourceOpen] = useState(false)

  const providerIds = Object.keys(SEARCH_PROVIDERS) as SearchProviderType[]
  const configuredProviders = providerIds
    .filter((id) => {
      const s = searchProviders[id]
      return !!s?.enabled && isProviderConfigured(id, s)
    })
    .sort((a, b) => (searchProviders[a]?.priority ?? 999) - (searchProviders[b]?.priority ?? 999))
  const hasUsableProvider = configuredProviders.length > 0
  const validCustomSources = customSearchSources.filter((source) => Boolean(source.domain))
  const visibleSourceIds = new Set([
    ...configuredProviders,
    ...BUILT_IN_DOMAIN_SOURCES.map((source) => source.id),
    ...validCustomSources.map((source) => source.id),
  ])
  const selectedSourceCount = defaultSearchSources.filter((id) => visibleSourceIds.has(id)).length

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
    const domain = normalizeSearchDomain(newSourceDomain)
    if (!name || !domain) {
      setSourceDomainInvalid(Boolean(newSourceDomain.trim()) && !domain)
      return
    }
    const id = `custom-${Date.now()}`
    const source = { id, name, domain }
    log.info("custom_source_added", source)
    void addCustomSearchSource(source)
    setNewSourceName("")
    setNewSourceDomain("")
    setSourceDomainInvalid(false)
    setAddSourceOpen(false)
  }

  const handleAddSourceOpenChange = (open: boolean) => {
    setAddSourceOpen(open)
    if (!open) setSourceDomainInvalid(false)
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
            disabled={configuredProviders.length === 0}
          >
            <SelectTrigger className="w-full">
              <SelectValue placeholder={t("selectProvider")} />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {configuredProviders.length > 0 ? (
                  configuredProviders.map((id) => (
                    <SelectItem key={id} value={id}>
                      <span className="flex items-center gap-2">
                        {SEARCH_PROVIDERS[id].name}
                        {searchProviders[id]?.priority === 1 && (
                          <Badge variant="outline" className="px-1 py-0 text-[10px]">
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
              </SelectGroup>
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
        />
        <p className="text-[10px] text-muted-foreground">{t("maxRetriesDesc")}</p>
      </div>

      <SettingsGroup
        title={t("researchSources")}
        icon={<Globe className="h-4 w-4" />}
        badge={`${selectedSourceCount} ${t("selected")}`}
      >
        <div className="space-y-3">
          {configuredProviders.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-muted-foreground">{t("researchProviders")}</p>
              <div className="flex flex-wrap gap-2">
                {configuredProviders.map((id) => (
                  <SourcePill
                    key={id}
                    sourceId={id}
                    name={SEARCH_PROVIDERS[id].name}
                    icon="🔎"
                    selected={defaultSearchSources.includes(id)}
                    disabled={false}
                    onToggle={() => toggleSearchSource(id)}
                  />
                ))}
              </div>
            </div>
          )}

          <div className="space-y-1.5">
            <p className="text-xs font-medium text-muted-foreground">{t("researchDomains")}</p>
            <div className="flex flex-wrap gap-2">
              {BUILT_IN_DOMAIN_SOURCES.map((source) => (
                <div key={source.id} className="inline-flex items-center gap-1">
                  <SourcePill
                    sourceId={source.id}
                    name={t(source.nameKey)}
                    icon={source.icon}
                    selected={defaultSearchSources.includes(source.id)}
                    disabled={false}
                    onToggle={() => toggleSearchSource(source.id)}
                  />
                  <span className="text-[10px] text-muted-foreground">{source.domain}</span>
                </div>
              ))}
            </div>
          </div>

          {customSearchSources.map((source) => {
            const isSelected = defaultSearchSources.includes(source.id)
            const isLegacyInvalid = !source.domain
            return (
              <div key={source.id} className="inline-flex items-center gap-1">
                <SourcePill
                  sourceId={source.id}
                  name={source.name}
                  icon={source.icon}
                  selected={isSelected}
                  disabled={isLegacyInvalid}
                  onToggle={() => toggleSearchSource(source.id)}
                  onRemove={() => {
                    log.info("custom_source_removed", { id: source.id })
                    void removeCustomSearchSource(source.id)
                    if (isSelected) {
                      void setDefaultSearchSources(
                        defaultSearchSources.filter((id) => id !== source.id)
                      )
                    }
                  }}
                />
                <span
                  className={cn(
                    "text-[10px] text-muted-foreground",
                    isLegacyInvalid && "text-destructive"
                  )}
                >
                  {source.domain ?? t("sourceNeedsDomain")}
                </span>
              </div>
            )
          })}

          <Dialog open={addSourceOpen} onOpenChange={handleAddSourceOpenChange}>
            <DialogTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className={cn(
                  "h-auto gap-1 rounded-pill border-dashed px-3 py-1.5 text-xs font-medium",
                  "cursor-pointer text-muted-foreground hover:bg-muted/50"
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
              <FieldGroup className="gap-4">
                <Field>
                  <FieldLabel htmlFor="custom-source-name">{t("sourceName")}</FieldLabel>
                  <Input
                    id="custom-source-name"
                    value={newSourceName}
                    onChange={(event) => setNewSourceName(event.target.value)}
                    placeholder={t("sourceNamePlaceholder")}
                  />
                </Field>
                <Field data-invalid={sourceDomainInvalid || undefined}>
                  <FieldLabel htmlFor="custom-source-domain">{t("sourceDomain")}</FieldLabel>
                  <Input
                    id="custom-source-domain"
                    value={newSourceDomain}
                    onChange={(event) => {
                      setNewSourceDomain(event.target.value)
                      if (sourceDomainInvalid) setSourceDomainInvalid(false)
                    }}
                    placeholder={t("sourceDomainPlaceholder")}
                    aria-invalid={sourceDomainInvalid || undefined}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault()
                        handleAddCustomSource()
                      }
                    }}
                  />
                  <FieldDescription>{t("sourceDomainHint")}</FieldDescription>
                  {sourceDomainInvalid && <FieldError>{t("invalidSourceDomain")}</FieldError>}
                </Field>
              </FieldGroup>
              <DialogFooter>
                <Button variant="outline" onClick={() => setAddSourceOpen(false)}>
                  {t("cancel")}
                </Button>
                <Button
                  onClick={handleAddCustomSource}
                  disabled={!newSourceName.trim() || !newSourceDomain.trim()}
                >
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
