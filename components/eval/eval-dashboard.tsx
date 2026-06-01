"use client"

/**
 * Agent evaluation dashboard. Lists datasets, lets the user create one, run an
 * evaluation against the chat target, and review per-run pass@1 / pass^k / cost
 * trends. The run wiring (scorers + sidecar target + judge client) is assembled
 * by `buildBrowserRunDeps`; runs persist as `EvalReport` rows.
 */

import { useCallback, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { ClipboardCheckIcon, PlayIcon, PlusIcon, Trash2Icon, Loader2Icon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Card } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { useSettingsStore } from "@/stores/settings/settings-store"
import { createDataset, deleteDataset } from "@/lib/db/eval-datasets"
import { buildBrowserRunDeps } from "@/lib/ai/eval/browser-deps"
import { runDatasetById } from "@/lib/ai/eval/run-controller"
import type { EvalReport } from "@/types/eval/eval"
import { useEvalDatasets, useEvalRuns } from "@/hooks/eval/use-eval-data"

function pct(value: number): string {
  return `${Math.round(value * 100)}%`
}

function RunCard({ run }: { run: EvalReport }) {
  const t = useTranslations("eval")
  return (
    <Card className="flex flex-col gap-2 p-3" data-testid="eval-run-card">
      <div className="flex items-center justify-between text-sm">
        <span className="font-medium">{run.targetLabel}</span>
        <span className="text-muted-foreground">
          {t("datasets.version", { version: run.datasetVersion })} · k={run.k}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
        <div>
          <div className="text-muted-foreground text-xs">{t("runs.passAt1")}</div>
          <div className="font-semibold">{pct(run.passAt1)}</div>
        </div>
        <div>
          <div className="text-muted-foreground text-xs">{t("runs.passHatK")}</div>
          <div className="font-semibold">{pct(run.passHatK)}</div>
        </div>
        <div>
          <div className="text-muted-foreground text-xs">{t("runs.cost")}</div>
          <div className="font-semibold">${run.totalCostUsd.toFixed(4)}</div>
        </div>
        <div>
          <div className="text-muted-foreground text-xs">{t("runs.latency")}</div>
          <div className="font-semibold">{Math.round(run.avgLatencyMs)}ms</div>
        </div>
      </div>
      <div className="flex flex-wrap gap-1">
        {Object.values(run.scorers).map((s) => (
          <Badge key={s.scorerId} variant="secondary" className="text-xs">
            {s.scorerId} {pct(s.passRate)}
          </Badge>
        ))}
      </div>
    </Card>
  )
}

export function EvalDashboard() {
  const t = useTranslations("eval")
  const datasets = useEvalDatasets()
  const settings = useSettingsStore((s) => s.settings)
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined)
  const runs = useEvalRuns(selectedId)

  const [creating, setCreating] = useState(false)
  const [name, setName] = useState("")
  const [capability, setCapability] = useState("")
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const effectiveSelected = selectedId ?? datasets[0]?.id
  const { deterministicOnly } = useMemo(
    () => buildBrowserRunDeps({ appSettings: settings }),
    [settings]
  )

  const handleCreate = useCallback(async () => {
    if (!name.trim() || !capability.trim()) return
    const ds = await createDataset({ name: name.trim(), capability: capability.trim() })
    setSelectedId(ds.id)
    setName("")
    setCapability("")
    setCreating(false)
  }, [name, capability])

  const handleRun = useCallback(async () => {
    if (!effectiveSelected) return
    setRunning(true)
    setError(null)
    try {
      const { deps } = buildBrowserRunDeps({ appSettings: settings })
      await runDatasetById(effectiveSelected, deps)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setRunning(false)
    }
  }, [effectiveSelected, settings])

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

        {/* Runs */}
        <div className="flex min-h-0 flex-col gap-2">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium">{t("runs.heading")}</h2>
            <div className="flex items-center gap-2">
              {effectiveSelected && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => effectiveSelected && void deleteDataset(effectiveSelected)}
                  aria-label={t("datasets.delete")}
                >
                  <Trash2Icon className="size-4" />
                </Button>
              )}
              <Button size="sm" disabled={!effectiveSelected || running} onClick={handleRun}>
                {running ? (
                  <Loader2Icon className="size-4 animate-spin" />
                ) : (
                  <PlayIcon className="size-4" />
                )}
                {running ? t("runs.running") : t("runs.run")}
              </Button>
            </div>
          </div>

          {deterministicOnly && (
            <p className="text-muted-foreground text-xs">{t("runs.deterministicOnly")}</p>
          )}
          {error && (
            <p className="text-destructive text-sm" role="alert">
              {t("runs.failed", { error })}
            </p>
          )}

          {!effectiveSelected ? (
            <p className="text-muted-foreground text-sm">{t("datasets.select")}</p>
          ) : runs.length === 0 ? (
            <p className="text-muted-foreground text-sm">{t("runs.empty")}</p>
          ) : (
            <div className="flex flex-col gap-2 overflow-y-auto">
              {runs.map((run) => (
                <RunCard key={run.runId} run={run} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
