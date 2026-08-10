"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { useVirtualizer } from "@tanstack/react-virtual"
import { useTranslations } from "next-intl"
import { SearchIcon, XIcon } from "lucide-react"
import type {
  CatalogModality,
  ModelCapability,
  ModelLifecycle,
} from "@cognia/provider-types/model-catalog"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { Switch } from "@/components/ui/switch"
import { cn } from "@/lib/utils"
import {
  getActiveCatalogSnapshot,
  getCatalogState,
  providerCatalogRepository,
} from "@/lib/db/provider-catalog"
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
  const scrollRef = useRef<HTMLDivElement>(null)

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
  // TanStack Virtual returns mutable methods that React Compiler cannot memoize safely.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: visible.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 76,
    overscan: 8,
  })

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

      <div className="grid gap-2 lg:grid-cols-[minmax(16rem,1fr)_auto_auto]">
        <label className="relative">
          <span className="sr-only">{t("searchLabel")}</span>
          <SearchIcon className="pointer-events-none absolute left-3 top-2.5 size-4 text-muted-foreground" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("searchPlaceholder")}
            className="pl-9"
          />
        </label>
        <NativeSelect
          className="text-sm"
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
          className="text-sm"
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
      </div>

      <div className="flex flex-wrap gap-2">
        {(["tools", "reasoning", "structuredOutput"] as ModelCapability[]).map((capability) => (
          <Button
            key={capability}
            type="button"
            size="sm"
            variant={capabilities.includes(capability) ? "default" : "outline"}
            onClick={() => toggleCapability(capability)}
            aria-pressed={capabilities.includes(capability)}
          >
            {t(`capabilities.${capability}`)}
          </Button>
        ))}
      </div>

      <div className="grid min-h-0 flex-1 gap-3 md:grid-cols-[minmax(20rem,1fr)_minmax(18rem,0.8fr)]">
        <div ref={scrollRef} className="min-h-0 overflow-auto rounded-lg border">
          {visible.length === 0 ? (
            <div className="flex min-h-48 flex-col items-center justify-center gap-1 p-6 text-center">
              <p className="font-medium">{t("emptyTitle")}</p>
              <p className="text-sm text-muted-foreground">{t("emptyDescription")}</p>
            </div>
          ) : (
            <div
              className="relative w-full"
              style={{ height: virtualizer.getTotalSize() }}
              role="list"
            >
              {virtualizer.getVirtualItems().map((virtualRow) => {
                const result = visible[virtualRow.index]
                const providerTiers = new Set(
                  result.offerings.map(
                    (offering) => providers.get(offering.providerRef)?.tier ?? "experimental"
                  )
                )
                return (
                  <div
                    key={result.model.id}
                    role="listitem"
                    className="absolute left-0 top-0 w-full border-b"
                    style={{
                      height: virtualRow.size,
                      transform: `translateY(${virtualRow.start}px)`,
                    }}
                  >
                    <button
                      type="button"
                      onClick={() => setSelectedId(result.model.id)}
                      className={cn(
                        "flex size-full items-center justify-between gap-3 px-3 text-left hover:bg-muted/60",
                        selectedId === result.model.id && "bg-muted"
                      )}
                    >
                      <span className="min-w-0">
                        <span className="block truncate font-medium">{result.model.name}</span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {result.model.id}
                        </span>
                      </span>
                      <span className="flex shrink-0 gap-1">
                        {[...providerTiers].map((tier) => (
                          <Badge key={tier} variant="outline">
                            {t(`tiers.${tier}`)}
                          </Badge>
                        ))}
                      </span>
                    </button>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        <div
          className={cn(
            "min-h-0 overflow-auto rounded-lg border bg-background p-4",
            selected
              ? "fixed inset-0 z-50 rounded-none md:static md:z-auto md:rounded-lg"
              : "hidden md:block"
          )}
        >
          {selected ? (
            <>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="float-right md:hidden"
                onClick={() => setSelectedId(undefined)}
                aria-label={t("closeDetails")}
              >
                <XIcon className="size-4" />
              </Button>
              <h3 className="pr-10 text-base font-semibold">{selected.model.name}</h3>
              <p className="mt-1 break-all text-xs text-muted-foreground">{selected.model.id}</p>
              <div className="mt-4 space-y-3">
                <div>
                  <p className="text-xs font-medium uppercase text-muted-foreground">
                    {t("lifecycleLabel")}
                  </p>
                  <p className="text-sm">{t(`lifecycles.${selected.model.lifecycle}`)}</p>
                </div>
                <div>
                  <p className="text-xs font-medium uppercase text-muted-foreground">
                    {t("offerings")}
                  </p>
                  <ul className="mt-1 space-y-2">
                    {selected.offerings.map((offering) => (
                      <li key={offering.id} className="rounded-md bg-muted/60 p-2 text-sm">
                        <p className="font-medium">
                          {providers.get(offering.providerRef)?.name ?? offering.providerRef}
                        </p>
                        <p className="break-all text-xs text-muted-foreground">
                          {t("routedId")}: {offering.upstreamId}
                        </p>
                      </li>
                    ))}
                  </ul>
                </div>
                {(selected.model.lifecycle === "deprecated" ||
                  selected.model.lifecycle === "retired") && (
                  <div className="rounded-md border border-warning/40 bg-warning/10 p-2 text-sm">
                    <p>{t("deprecated")}</p>
                    {replacementByModel.get(selected.model.id) && (
                      <p className="mt-1 break-all text-xs">
                        {t("replacement")}: <code>{replacementByModel.get(selected.model.id)}</code>
                      </p>
                    )}
                  </div>
                )}
              </div>
            </>
          ) : (
            <div className="flex h-full min-h-48 items-center justify-center text-sm text-muted-foreground">
              {t("selectModel")}
            </div>
          )}
        </div>
      </div>
    </section>
  )
}
