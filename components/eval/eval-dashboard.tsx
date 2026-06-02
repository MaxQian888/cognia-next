"use client"

/**
 * Datasets pane: a dataset list + create form on the left, and the selected
 * dataset's {@link DatasetDetail} (cases CRUD + import + versions + run) on the
 * right. Runs + comparison live in the separate "Runs & Compare" tab.
 */

import { useCallback, useState } from "react"
import { useTranslations } from "next-intl"
import { ClipboardCheckIcon, PlusIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useSettingsStore } from "@/stores/settings/settings-store"
import { createDataset } from "@/lib/db/eval-datasets"
import { useEvalDatasets } from "@/hooks/eval/use-eval-data"
import { DatasetDetail } from "./dataset-detail"

export function EvalDashboard() {
  const t = useTranslations("eval")
  const datasets = useEvalDatasets()
  const settings = useSettingsStore((s) => s.settings)
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined)

  const [creating, setCreating] = useState(false)
  const [name, setName] = useState("")
  const [capability, setCapability] = useState("")

  const effectiveSelected = selectedId ?? datasets[0]?.id
  const selectedDataset = datasets.find((d) => d.id === effectiveSelected)

  const handleCreate = useCallback(async () => {
    if (!name.trim() || !capability.trim()) return
    const ds = await createDataset({ name: name.trim(), capability: capability.trim() })
    setSelectedId(ds.id)
    setName("")
    setCapability("")
    setCreating(false)
  }, [name, capability])

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 p-4">
      <header className="flex items-center gap-2">
        <ClipboardCheckIcon className="size-5" />
        <div>
          <h1 className="text-lg font-semibold">{t("title")}</h1>
          <p className="text-muted-foreground text-sm">{t("subtitle")}</p>
        </div>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 md:grid-cols-[280px_1fr]">
        {/* Dataset list */}
        <div className="flex min-h-0 flex-col gap-2">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium">{t("datasets.heading")}</h2>
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
                <Button size="sm" onClick={handleCreate}>
                  {t("datasets.create")}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setCreating(false)}>
                  {t("datasets.cancel")}
                </Button>
              </div>
            </div>
          )}

          {datasets.length === 0 && !creating ? (
            <p className="text-muted-foreground text-sm">{t("datasets.empty")}</p>
          ) : (
            <ul className="flex flex-col gap-1 overflow-y-auto">
              {datasets.map((ds) => (
                <li key={ds.id}>
                  <button
                    type="button"
                    onClick={() => setSelectedId(ds.id)}
                    className={`flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent ${
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

        {/* Detail */}
        <div className="min-h-0 overflow-y-auto">
          {selectedDataset ? (
            <DatasetDetail dataset={selectedDataset} appSettings={settings} />
          ) : (
            <p className="text-muted-foreground text-sm">{t("datasets.select")}</p>
          )}
        </div>
      </div>
    </div>
  )
}
