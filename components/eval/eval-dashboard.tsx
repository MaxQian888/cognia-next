"use client"

/**
 * Datasets pane — master-detail mirroring the Skills page: a 320px bordered
 * list pane (search + dataset rows + create form) and an inline detail pane.
 * Below `md` the panes are exclusive: list first, tapping a dataset swaps to
 * the detail with a back affordance. Selection is DERIVED (no
 * set-state-in-effect): an explicit click wins, else the first filtered row.
 */

import { useCallback, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { ArrowLeftIcon, ClipboardCheckIcon, PlusIcon } from "lucide-react"
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
    <div className="flex h-full min-h-0 flex-col gap-3 p-3 sm:gap-4 sm:p-4">
      <header className="flex items-center gap-2">
        {isMobile && mobileDetailOpen && (
          <Button
            size="icon"
            variant="ghost"
            aria-label={t("datasets.back")}
            onClick={() => setMobileDetailOpen(false)}
          >
            <ArrowLeftIcon className="size-4" />
          </Button>
        )}
        <ClipboardCheckIcon className="size-5" />
        <div className="min-w-0">
          <h1 className="truncate text-lg font-semibold">{t("title")}</h1>
          <p className="text-muted-foreground truncate text-sm">{t("subtitle")}</p>
        </div>
      </header>

      <div
        className="grid min-h-0 flex-1 gap-3 sm:gap-4"
        // Driven by the SAME source as showList/showDetail. A Tailwind `md:`
        // rule disagrees with `useIsMobile()` on a native tablet shell, which
        // left half the screen blank.
        style={{ gridTemplateColumns: isMobile ? "1fr" : "320px 1fr" }}
      >
        {showList && (
          <div className="flex min-h-0 flex-col gap-2 overflow-hidden rounded-lg border p-2">
            <div className="flex items-center justify-between gap-2">
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
                className="flex flex-col gap-2 rounded-md border p-2"
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
              <p className="text-muted-foreground p-2 text-sm">{t("datasets.empty")}</p>
            ) : (
              <ul className="flex min-h-0 flex-col gap-1 overflow-y-auto">
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
          <div className="flex min-h-0 flex-col overflow-hidden rounded-lg border p-3">
            {selectedDataset ? (
              <DatasetDetail
                dataset={selectedDataset}
                appSettings={settings}
                runOptions={runOptions}
              />
            ) : (
              <p className="text-muted-foreground text-sm">{t("datasets.select")}</p>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
