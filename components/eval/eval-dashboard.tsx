"use client"

/**
 * Datasets pane — master-detail laid out the way the Skills page actually
 * does it: one full-bleed surface split by a hairline, not two rounded cards
 * floating inside a page that already has a frame. The old shape nested three
 * borders deep (page → list card → create-form card) and the pane was the
 * only thing keeping the two halves apart, so the split read as decoration
 * rather than structure.
 *
 * It also renders no title of its own. Both mounts (`EvalWorkspace` and
 * `EvalLabWorkspace`) sit under a `FeaturePageHeader` carrying the very same
 * `eval.title` / `eval.subtitle`, so the page printed its name twice and
 * shipped two `<h1>`s.
 *
 * Below `md` the panes are exclusive: list first, tapping a dataset swaps to
 * the detail with a back affordance. Selection is DERIVED (no
 * set-state-in-effect): an explicit click wins, else the first filtered row.
 */

import { useCallback, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { ArrowLeftIcon, PlusIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useSettingsStore } from "@/stores/settings/settings-store"
import { useIsMobile } from "@/hooks/ui/use-mobile"
import { createDataset } from "@/lib/db/eval-datasets"
import { resolveEvalSettings } from "@/lib/ai/eval/settings"
import { useEvalDatasets } from "@/hooks/eval/use-eval-data"
import { useRunConfigOptions } from "@/hooks/eval/use-run-config-options"
import { DatasetDetail } from "./dataset-detail"

export function EvalDashboard() {
  const t = useTranslations("eval")
  const datasets = useEvalDatasets()
  const settings = useSettingsStore((s) => s.settings)
  const runOptions = useRunConfigOptions()
  const isMobile = useIsMobile()

  const [selectedId, setSelectedId] = useState<string | undefined>(undefined)
  const [mobileDetailOpen, setMobileDetailOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState("")
  const [capability, setCapability] = useState("")

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return datasets
    return datasets.filter(
      (d) => d.name.toLowerCase().includes(q) || d.capability.toLowerCase().includes(q)
    )
  }, [datasets, query])

  const effectiveSelected = selectedId ?? filtered[0]?.id
  const selectedDataset = datasets.find((d) => d.id === effectiveSelected)

  const handleCreate = useCallback(async () => {
    if (!name.trim() || !capability.trim()) return
    const defaultGate = resolveEvalSettings(settings).defaultGate
    const ds = await createDataset({
      name: name.trim(),
      capability: capability.trim(),
      ...(defaultGate ? { gate: defaultGate } : {}),
    })
    setSelectedId(ds.id)
    setMobileDetailOpen(true)
    setName("")
    setCapability("")
    setCreating(false)
  }, [name, capability, settings])

  const select = (id: string) => {
    setSelectedId(id)
    setMobileDetailOpen(true)
  }

  const showList = !isMobile || !mobileDetailOpen
  const showDetail = !isMobile || mobileDetailOpen

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* The only thing the old header still earned: a way back out of the
          detail on a phone. It names the row it returns from, so the back
          arrow is not the sole thing on an otherwise blank bar. */}
      {isMobile && mobileDetailOpen && (
        <div className="flex min-h-9 shrink-0 items-center gap-1 border-b px-1.5">
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={t("datasets.back")}
            onClick={() => setMobileDetailOpen(false)}
          >
            <ArrowLeftIcon className="size-4" />
          </Button>
          <span className="min-w-0 truncate text-sm font-medium">
            {selectedDataset?.name ?? t("datasets.select")}
          </span>
        </div>
      )}

      <div
        className={cn("grid min-h-0 flex-1", !isMobile && "divide-x")}
        // Driven by the SAME source as showList/showDetail. A Tailwind `md:`
        // rule disagrees with `useIsMobile()` on a native tablet shell, which
        // left half the screen blank — and that applies to the divider too,
        // hence the conditional class rather than `md:divide-x`.
        style={{ gridTemplateColumns: isMobile ? "1fr" : "320px minmax(0,1fr)" }}
      >
        {showList && (
          <div className="flex min-h-0 min-w-0 flex-col overflow-hidden">
            <div className="flex shrink-0 items-center justify-between gap-2 border-b px-3 py-2">
              <Input
                aria-label={t("datasets.searchPlaceholder")}
                placeholder={t("datasets.searchPlaceholder")}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="h-8"
              />
              <Button size="sm" variant="ghost" onClick={() => setCreating((v) => !v)}>
                <PlusIcon className="size-4" />
                {t("datasets.new")}
              </Button>
            </div>

            {creating && (
              <div
                className="flex shrink-0 flex-col gap-2 border-b bg-muted/30 px-3 py-3"
                data-testid="new-dataset-form"
              >
                <Input
                  aria-label={t("datasets.namePlaceholder")}
                  placeholder={t("datasets.namePlaceholder")}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
                <Input
                  aria-label={t("datasets.capabilityPlaceholder")}
                  placeholder={t("datasets.capabilityPlaceholder")}
                  value={capability}
                  onChange={(e) => setCapability(e.target.value)}
                />
                <div className="flex gap-2">
                  <Button size="sm" onClick={() => void handleCreate()}>
                    {t("datasets.create")}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setCreating(false)}>
                    {t("datasets.cancel")}
                  </Button>
                </div>
              </div>
            )}

            {filtered.length === 0 && !creating ? (
              <p className="text-muted-foreground px-3 py-3 text-sm">{t("datasets.empty")}</p>
            ) : (
              <ul className="flex min-h-0 flex-col gap-0.5 overflow-y-auto p-2">
                {filtered.map((ds) => (
                  <li key={ds.id}>
                    <button
                      type="button"
                      onClick={() => select(ds.id)}
                      className={`hover:bg-accent flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-sm ${
                        ds.id === effectiveSelected ? "bg-accent" : ""
                      }`}
                    >
                      <span className="truncate">{ds.name}</span>
                      <span className="text-muted-foreground ml-2 shrink-0 text-xs">
                        {t("datasets.version", { version: ds.version })}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {showDetail && (
          <div className="flex min-h-0 min-w-0 flex-col overflow-hidden p-3 sm:p-4">
            {selectedDataset ? (
              <DatasetDetail
                dataset={selectedDataset}
                appSettings={settings}
                runOptions={runOptions}
              />
            ) : (
              <p className="text-muted-foreground text-sm" data-testid="eval-detail-prompt">
                {/* "Select a dataset" beside an empty list asks for something
                    that is not there yet. */}
                {datasets.length === 0 ? t("datasets.selectEmpty") : t("datasets.select")}
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
