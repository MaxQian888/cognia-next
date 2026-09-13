"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { useVirtualizer } from "@tanstack/react-virtual"
import { useTranslations } from "next-intl"
import { ArrowLeft, SearchIcon, XIcon } from "lucide-react"
import type {
  CatalogModality,
  CatalogModelCapabilities,
  ModelCapability,
  ModelLifecycle,
} from "@cognia/provider-types/model-catalog"

import {
  SettingsListDetail,
  useSettingsListDensity,
} from "@/components/settings/common/settings-master-detail"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { Switch } from "@/components/ui/switch"
import { ProviderIcon } from "@/components/providers/ai/provider-icon"
import { cn } from "@/lib/utils"
import {
  getActiveCatalogSnapshot,
  getCatalogState,
  providerCatalogRepository,
} from "@/lib/db/provider-catalog"
import { ModelCapabilityIcons, type ModelCapabilityId } from "./model-capability-icons"
import { formatTokenCount } from "./model-format"
import {
  filterCatalogSearchDocuments,
  type CatalogSearchDocument,
} from "./model-catalog-search.worker"

const MODALITIES: Array<"all" | CatalogModality> = [
  "all",
  "language",
  "embedding",
  "rerank",
  "image",
  "speech",
]
const LIFECYCLES: Array<"recommended" | ModelLifecycle> = [
  "recommended",
  "preview",
  "active",
  "deprecated",
  "retired",
]

/** Row height for the virtualizer: two text lines plus padding. */
const ROW_HEIGHT = 56

/**
 * Catalog capability flags → the shared glyph ids, so the catalog list shows
 * the same icons the Models tab does. Flags without a glyph (temperature,
 * rerank, speech) are not model capabilities a user scans for in a list.
 */
const CATALOG_CAPABILITY_TO_ICON: Partial<
  Record<keyof CatalogModelCapabilities, ModelCapabilityId>
> = {
  tools: "tools",
  reasoning: "reasoning",
  streaming: "streaming",
  structuredOutput: "structured",
  attachments: "attachment",
  embeddings: "embedding",
  imageGeneration: "image-gen",
}

export function catalogCapabilityIds(capabilities: CatalogModelCapabilities | undefined): string[] {
  if (!capabilities) return []
  const ids: string[] = []
  for (const [flag, icon] of Object.entries(CATALOG_CAPABILITY_TO_ICON)) {
    if (capabilities[flag as keyof CatalogModelCapabilities]) ids.push(icon)
  }
  return ids
}

function useWorkerSearch(documents: CatalogSearchDocument[], query: string): Set<string> {
  const [ids, setIds] = useState(() => new Set(documents.map((document) => document.id)))
  const requestId = useRef(0)
  const workerRef = useRef<Worker | null>(null)
  const fallbackIds = useMemo(
    () => new Set(filterCatalogSearchDocuments(documents, query)),
    [documents, query]
  )

  useEffect(() => {
    if (typeof Worker === "undefined") {
      return
    }
    const worker = new Worker(new URL("./model-catalog-search.worker.ts", import.meta.url))
    workerRef.current = worker
    worker.postMessage({ type: "init", documents })
    worker.onmessage = (event: MessageEvent<{ requestId: number; ids: string[] }>) => {
      if (event.data.requestId === requestId.current) setIds(new Set(event.data.ids))
    }
    return () => {
      workerRef.current = null
      worker.terminate()
    }
  }, [documents])

  useEffect(() => {
    const current = ++requestId.current
    if (typeof Worker === "undefined") {
      return
    }
    workerRef.current?.postMessage({ type: "search", requestId: current, query })
  }, [documents, query])

  return typeof Worker === "undefined" ? fallbackIds : ids
}

type CatalogResult = ReturnType<typeof providerCatalogRepository.searchModels>[number]

export function ModelCatalogSection() {
  const t = useTranslations("modelCatalog")
  const state = useLiveQuery(() => getCatalogState(), [])
  const snapshot = useLiveQuery(() => getActiveCatalogSnapshot(), [state?.activeRevisionId])
  const [advanced, setAdvanced] = useState(false)
  const [query, setQuery] = useState("")
  const [modality, setModality] = useState<(typeof MODALITIES)[number]>("all")
  const [lifecycle, setLifecycle] = useState<(typeof LIFECYCLES)[number]>("recommended")
  const [capabilities, setCapabilities] = useState<ModelCapability[]>([])
  const [selectedId, setSelectedId] = useState<string>()

  const providers = useMemo(() => {
    if (!snapshot) return new Map()
    return new Map(
      providerCatalogRepository.listProviders().map((provider) => [provider.id, provider])
    )
  }, [snapshot])
  const results = useMemo(() => {
    if (!snapshot) return []
    return providerCatalogRepository.searchModels({
      tiers: advanced ? undefined : ["certified"],
      lifecycle: !advanced || lifecycle === "recommended" ? ["active"] : [lifecycle],
      modalities: modality === "all" ? undefined : [modality],
      capabilities: capabilities.length > 0 ? capabilities : undefined,
    })
  }, [advanced, capabilities, lifecycle, modality, snapshot])
  const aliasesByModel = useMemo(() => {
    const offeringToModel = new Map(
      (snapshot?.offerings ?? []).map((offering) => [offering.id, offering.modelRef])
    )
    const aliases = new Map<string, string[]>()
    for (const alias of snapshot?.aliases ?? []) {
      const modelId =
        alias.target.type === "model"
          ? alias.target.ref
          : alias.target.type === "offering"
            ? offeringToModel.get(alias.target.ref)
            : undefined
      if (!modelId) continue
      const existing = aliases.get(modelId)
      if (existing) existing.push(alias.id)
      else aliases.set(modelId, [alias.id])
    }
    return aliases
  }, [snapshot])
  const replacementByModel = useMemo(() => {
    const replacements = new Map<string, string>()
    for (const alias of snapshot?.aliases ?? []) {
      if (alias.target.type === "model" && alias.replacementRef) {
        replacements.set(alias.target.ref, alias.replacementRef)
      }
    }
    return replacements
  }, [snapshot])
  const documents = useMemo<CatalogSearchDocument[]>(
    () =>
      results.map(({ model, offerings }) => ({
        id: model.id,
        searchText: [
          model.id,
          model.name,
          model.creator,
          model.family ?? "",
          ...(aliasesByModel.get(model.id) ?? []),
          ...offerings.flatMap((offering) => [
            offering.id,
            offering.upstreamId,
            offering.providerRef,
            offering.deploymentRef ?? "",
            providers.get(offering.providerRef)?.name ?? "",
          ]),
        ]
          .join("\n")
          .toLocaleLowerCase(),
      })),
    [aliasesByModel, providers, results]
  )
  const matchingIds = useWorkerSearch(documents, query)
  const visible = useMemo(
    () => results.filter((result) => matchingIds.has(result.model.id)),
    [matchingIds, results]
  )
  const selected = visible.find((result) => result.model.id === selectedId)

  const toggleCapability = (capability: ModelCapability) => {
    setCapabilities((current) =>
      current.includes(capability)
        ? current.filter((item) => item !== capability)
        : [...current, capability]
    )
  }

  if (state === undefined) {
    return (
      <div className="flex min-h-64 items-center justify-center text-sm text-muted-foreground">
        {t("loading")}
      </div>
    )
  }

  if (!state.activeRevisionId) {
    return (
      <div className="flex min-h-64 flex-col items-center justify-center gap-2 text-center">
        <p className="font-medium">{t("recoveryTitle")}</p>
        <p className="max-w-md text-sm text-muted-foreground">{t("recoveryDescription")}</p>
      </div>
    )
  }

  if (snapshot === undefined) {
    return (
      <div className="flex min-h-64 items-center justify-center text-sm text-muted-foreground">
        {t("loading")}
      </div>
    )
  }

  return (
    <section className="flex min-h-0 flex-1 flex-col gap-3" aria-label={t("title")}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">{t("title")}</h2>
          <p className="text-sm text-muted-foreground">{t("description")}</p>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <Switch checked={advanced} onCheckedChange={setAdvanced} />
          {t("advanced")}
        </label>
      </div>

      {typeof navigator !== "undefined" && !navigator.onLine && (
        <div className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm">
          {t("offline")}
        </div>
      )}

      {state.stagedRevisionIds.length > 0 && (
        <div className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm">
          {t("conflict")}
        </div>
      )}

      {/* Toolbar: search, then the two axis selects, then capability chips in
          the same h-6 chip style the provider Models tab uses. */}
      <div className="flex flex-wrap items-center gap-2">
        <label className="relative min-w-[12rem] flex-1">
          <span className="sr-only">{t("searchLabel")}</span>
          <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("searchPlaceholder")}
            className="h-8 pl-8"
          />
        </label>
        <NativeSelect
          className="h-8 text-sm"
          value={modality}
          onChange={(event) => setModality(event.target.value as (typeof MODALITIES)[number])}
          aria-label={t("modalityLabel")}
        >
          {MODALITIES.map((item) => (
            <NativeSelectOption key={item} value={item}>
              {t(`modalities.${item}`)}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        <NativeSelect
          className="h-8 text-sm"
          value={lifecycle}
          disabled={!advanced}
          onChange={(event) => setLifecycle(event.target.value as (typeof LIFECYCLES)[number])}
          aria-label={t("lifecycleLabel")}
        >
          {LIFECYCLES.map((item) => (
            <NativeSelectOption key={item} value={item}>
              {t(`lifecycles.${item}`)}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        <div className="flex flex-wrap gap-1" role="group" aria-label={t("capabilitiesLabel")}>
          {(["tools", "reasoning", "structuredOutput"] as ModelCapability[]).map((capability) => (
            <Button
              key={capability}
              type="button"
              size="sm"
              variant={capabilities.includes(capability) ? "secondary" : "outline"}
              className={cn(
                "h-6 px-2 text-xs font-normal",
                capabilities.includes(capability) && "border-primary/40"
              )}
              onClick={() => toggleCapability(capability)}
              aria-pressed={capabilities.includes(capability)}
            >
              {t(`capabilities.${capability}`)}
            </Button>
          ))}
        </div>
        <span className="ml-auto text-xs text-muted-foreground" role="status">
          {t("countSummary", { shown: visible.length, total: results.length })}
        </span>
      </div>

      {/* Master/detail on the shared container-query frame. The old
          `md:grid-cols-[…]` read the viewport, so a 1000px window with the
          settings sidebar open got two columns into a pane that could hold
          one, and below `md` the detail became a `fixed inset-0` sheet over
          the whole app. Now the list is the page below the split threshold
          and a row pushes the detail in. */}
      <SettingsListDetail listWidth={420} data-testid="model-catalog-layout">
        <CatalogList
          visible={visible}
          providers={providers}
          selectedId={selectedId}
          onSelect={setSelectedId}
          hidden={selected !== undefined}
        />
        <CatalogDetail
          selected={selected}
          providers={providers}
          replacement={selected ? replacementByModel.get(selected.model.id) : undefined}
          onClose={() => setSelectedId(undefined)}
        />
      </SettingsListDetail>
    </section>
  )
}

/* ── List pane ───────────────────────────────────────────────────────────── */

function CatalogList({
  visible,
  providers,
  selectedId,
  onSelect,
  hidden,
}: {
  visible: CatalogResult[]
  providers: Map<string, { name: string; tier?: string }>
  selectedId: string | undefined
  onSelect: (id: string) => void
  /** A row is open; on a stacked pane the list yields the page to it. */
  hidden: boolean
}) {
  const t = useTranslations("modelCatalog")
  const density = useSettingsListDensity()
  const scrollRef = useRef<HTMLDivElement>(null)
  // TanStack Virtual returns mutable methods that React Compiler cannot memoize safely.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: visible.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 8,
  })

  if (density === "stacked" && hidden) return null

  return (
    <div
      ref={scrollRef}
      className={cn(
        "min-h-0 overflow-auto rounded-lg border",
        density === "stacked" && "row-span-2"
      )}
      data-testid="model-catalog-list"
    >
      {visible.length === 0 ? (
        <div className="flex min-h-48 flex-col items-center justify-center gap-1 p-6 text-center">
          <p className="font-medium">{t("emptyTitle")}</p>
          <p className="text-sm text-muted-foreground">{t("emptyDescription")}</p>
        </div>
      ) : (
        <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }} role="list">
          {virtualizer.getVirtualItems().map((virtualRow) => {
            const result = visible[virtualRow.index]
            const providerTiers = new Set(
              result.offerings.map(
                (offering) => providers.get(offering.providerRef)?.tier ?? "experimental"
              )
            )
            const isSelected = selectedId === result.model.id
            const lifecycle = result.model.lifecycle
            const context = result.model.limits?.context
            return (
              <div
                key={result.model.id}
                role="listitem"
                className="absolute left-0 top-0 w-full border-b last:border-b-0"
                style={{
                  height: virtualRow.size,
                  transform: `translateY(${virtualRow.start}px)`,
                }}
              >
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => onSelect(result.model.id)}
                  aria-current={isSelected ? "true" : undefined}
                  className={cn(
                    "size-full justify-start gap-3 whitespace-normal rounded-none px-3 text-left font-normal hover:bg-muted/40",
                    isSelected && "bg-accent shadow-[inset_2px_0_0_0_var(--primary)]"
                  )}
                >
                  <ProviderIcon
                    providerId={result.model.creator}
                    label={result.model.creator}
                    size={24}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex min-w-0 items-center gap-1.5">
                      <span className="truncate text-sm font-medium">{result.model.name}</span>
                      {lifecycle !== "active" && (
                        <Badge
                          variant={
                            lifecycle === "deprecated" || lifecycle === "retired"
                              ? "destructive"
                              : "outline"
                          }
                          className="px-1.5 py-0 text-[10px]"
                        >
                          {t(`lifecycles.${lifecycle}`)}
                        </Badge>
                      )}
                    </span>
                    <span className="block truncate font-mono text-[11px] text-muted-foreground">
                      {result.model.id}
                    </span>
                  </span>
                  <ModelCapabilityIcons
                    capabilities={catalogCapabilityIds(result.model.capabilities)}
                    className="hidden shrink-0 @[520px]/settings-pane:inline-flex"
                  />
                  {context !== undefined && (
                    <span className="hidden w-12 shrink-0 text-right font-mono text-xs tabular-nums text-muted-foreground @[640px]/settings-pane:inline">
                      {formatTokenCount(context)}
                    </span>
                  )}
                  <span className="flex shrink-0 gap-1">
                    {[...providerTiers].map((tier) => (
                      <Badge key={tier} variant="outline" className="px-1.5 py-0 text-[10px]">
                        {t(`tiers.${tier}`)}
                      </Badge>
                    ))}
                  </span>
                </Button>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

/* ── Detail pane ─────────────────────────────────────────────────────────── */

function CatalogDetail({
  selected,
  providers,
  replacement,
  onClose,
}: {
  selected: CatalogResult | undefined
  providers: Map<string, { name: string }>
  replacement: string | undefined
  onClose: () => void
}) {
  const t = useTranslations("modelCatalog")
  const density = useSettingsListDensity()

  // Stacked and nothing open: the list owns the page.
  if (density === "stacked" && !selected) return null

  return (
    <div
      className={cn(
        "flex min-h-0 flex-col overflow-hidden rounded-lg border bg-background",
        density === "stacked" && "row-span-2"
      )}
      data-testid="model-catalog-detail"
    >
      {selected ? (
        <>
          <div className="flex shrink-0 items-center gap-2 border-b px-3 py-2">
            {density === "stacked" && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="gap-1.5 pl-1"
                onClick={onClose}
                data-testid="model-catalog-back"
              >
                <ArrowLeft className="size-4" />
                {t("backToList")}
              </Button>
            )}
            <div className="min-w-0 flex-1">
              <h3 className="truncate text-base font-semibold">{selected.model.name}</h3>
              <p className="truncate font-mono text-xs text-muted-foreground">
                {selected.model.id}
              </p>
            </div>
            {density === "split" && (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-8"
                onClick={onClose}
                aria-label={t("closeDetails")}
              >
                <XIcon className="size-4" />
              </Button>
            )}
          </div>
          <div className="min-h-0 flex-1 space-y-4 overflow-auto p-4">
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <p className="text-xs font-medium uppercase text-muted-foreground">
                  {t("lifecycleLabel")}
                </p>
                <p>{t(`lifecycles.${selected.model.lifecycle}`)}</p>
              </div>
              <div>
                <p className="text-xs font-medium uppercase text-muted-foreground">
                  {t("creator")}
                </p>
                <p className="truncate">{selected.model.creator}</p>
              </div>
              {selected.model.limits?.context !== undefined && (
                <div>
                  <p className="text-xs font-medium uppercase text-muted-foreground">
                    {t("contextWindow")}
                  </p>
                  <p className="font-mono tabular-nums">
                    {formatTokenCount(selected.model.limits.context)}
                  </p>
                </div>
              )}
              {selected.model.limits?.output !== undefined && (
                <div>
                  <p className="text-xs font-medium uppercase text-muted-foreground">
                    {t("maxOutput")}
                  </p>
                  <p className="font-mono tabular-nums">
                    {formatTokenCount(selected.model.limits.output)}
                  </p>
                </div>
              )}
            </div>
            {catalogCapabilityIds(selected.model.capabilities).length > 0 && (
              <div>
                <p className="text-xs font-medium uppercase text-muted-foreground">
                  {t("capabilitiesLabel")}
                </p>
                <ModelCapabilityIcons
                  capabilities={catalogCapabilityIds(selected.model.capabilities)}
                  className="mt-1"
                />
              </div>
            )}
            <div>
              <p className="text-xs font-medium uppercase text-muted-foreground">
                {t("offerings")}
              </p>
              <ul className="mt-1 space-y-2">
                {selected.offerings.map((offering) => (
                  <li
                    key={offering.id}
                    className="flex items-start gap-2 rounded-md bg-muted/60 p-2 text-sm"
                  >
                    <ProviderIcon
                      providerId={offering.providerRef}
                      label={providers.get(offering.providerRef)?.name ?? offering.providerRef}
                      size={20}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block font-medium">
                        {providers.get(offering.providerRef)?.name ?? offering.providerRef}
                      </span>
                      <span className="block break-all text-xs text-muted-foreground">
                        {t("routedId")}: {offering.upstreamId}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
            {(selected.model.lifecycle === "deprecated" ||
              selected.model.lifecycle === "retired") && (
              <div className="rounded-md border border-warning/40 bg-warning/10 p-2 text-sm">
                <p>{t("deprecated")}</p>
                {replacement && (
                  <p className="mt-1 break-all text-xs">
                    {t("replacement")}: <code>{replacement}</code>
                  </p>
                )}
              </div>
            )}
          </div>
        </>
      ) : (
        <div className="flex h-full min-h-48 items-center justify-center p-4 text-sm text-muted-foreground">
          {t("selectModel")}
        </div>
      )}
    </div>
  )
}
