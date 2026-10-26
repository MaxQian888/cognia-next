"use client"

import { useEffect, useState } from "react"
import { usePluginTranslations } from "@cognia/plugin-sdk/api/i18n"
import {
  Badge,
  Button,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@cognia/plugin-ui"

import { PLUGIN_ID } from "../model"
import type { GovernanceRuntime } from "../runtime/runtime"
import { compareEvals, type CheckComparison } from "../verify/compare"
import { act } from "./act"
import { formatDateTime, percent } from "./format"
import type { GovernanceData } from "./use-governance"

export interface VerifyTabProps {
  runtime: GovernanceRuntime
  workspaceId: string | null
  data: GovernanceData
  busy: boolean
}

export function VerifyTab({ runtime, workspaceId, data, busy }: VerifyTabProps) {
  const t = usePluginTranslations(PLUGIN_ID)
  const locale = t("format.locale")
  const [comparisons, setComparisons] = useState<Record<string, CheckComparison[]>>({})
  const [datasets, setDatasets] = useState<Array<{ id: string; name: string }> | null>(null)
  const [datasetId, setDatasetId] = useState("")
  const [model, setModel] = useState(() => runtime.targetModel())
  const [changeId, setChangeId] = useState<string>("")

  useEffect(() => {
    let cancelled = false
    runtime.evalDatasets().then(
      (list) => {
        if (cancelled) return
        setDatasets(list)
        setDatasetId((current) => current || list[0]?.id || "")
      },
      () => {
        if (!cancelled) setDatasets([])
      }
    )
    return () => {
      cancelled = true
    }
  }, [runtime])

  const compare = (id: string) =>
    act(
      runtime.compareSinceChange(id).then((result) => {
        if (result) setComparisons((current) => ({ ...current, [id]: result }))
      }),
      t
    )

  const runEval = (role: "baseline" | "candidate") =>
    act(
      runtime.runEval({
        role,
        workspaceId,
        datasetId,
        model: model.trim(),
        ...(role === "candidate" && changeId ? { changeId } : {}),
      }),
      t
    )

  const evalComparisons = compareEvals(data.evals)
  const canRunEval = !busy && datasetId !== "" && model.trim() !== "" && workspaceId !== null

  return (
    <div className="space-y-4 p-3" data-testid="governance-verify">
      <section className="space-y-2">
        <h3 className="text-xs font-semibold">{t("verify.adherenceTitle")}</h3>
        <p className="text-[11px] text-muted-foreground">{t("verify.adherenceHint")}</p>
        {data.applied.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t("verify.noChanges")}</p>
        ) : (
          <ul className="space-y-2">
            {data.applied.map((change) => (
              <li
                key={change.id}
                className="space-y-1.5 rounded-md border p-2"
                data-change-id={change.id}
              >
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="font-medium">{change.surfaceName}</span>
                  <span className="text-muted-foreground">{formatDateTime(locale, change.at)}</span>
                  <span className="text-muted-foreground">
                    {t("verify.hunks", { count: change.hunks })}
                  </span>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="ml-auto"
                    disabled={busy || !data.checks}
                    onClick={() => compare(change.id)}
                  >
                    {t("verify.compare")}
                  </Button>
                </div>
                {comparisons[change.id] && (
                  <ul className="space-y-1">
                    {comparisons[change.id]!.length === 0 && (
                      <li className="text-[11px] text-muted-foreground">{t("verify.noChecks")}</li>
                    )}
                    {comparisons[change.id]!.map((row) => (
                      <li key={row.checkId} className="flex items-center gap-2 text-[11px]">
                        <Badge
                          variant={row.direction === "worse" ? "destructive" : "outline"}
                          className="text-[10px]"
                        >
                          {t(`direction.${row.direction}`)}
                        </Badge>
                        <span className="min-w-0 flex-1 truncate">
                          {data.checksById.get(row.checkId)?.summary ?? row.checkId}
                        </span>
                        <span className="text-muted-foreground">
                          {t("verify.rates", {
                            before: percent(row.before),
                            after: percent(row.after),
                            beforeCount: row.beforeOpportunities,
                            afterCount: row.afterOpportunities,
                          })}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-2">
        <h3 className="text-xs font-semibold">{t("verify.evalTitle")}</h3>
        <p className="text-[11px] text-muted-foreground">{t("verify.evalHint")}</p>
        {workspaceId === null && (
          <p className="text-xs text-muted-foreground">{t("verify.evalNeedsWorkspace")}</p>
        )}
        {datasets !== null && datasets.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t("verify.noDatasets")}</p>
        ) : (
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="space-y-1">
              <Label className="text-xs">{t("verify.dataset")}</Label>
              <Select value={datasetId} onValueChange={setDatasetId}>
                <SelectTrigger className="h-7 text-xs" aria-label={t("verify.dataset")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(datasets ?? []).map((dataset) => (
                    <SelectItem key={dataset.id} value={dataset.id}>
                      {dataset.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="governance-eval-model" className="text-xs">
                {t("verify.model")}
              </Label>
              <Input
                id="governance-eval-model"
                className="h-7 text-xs"
                value={model}
                onChange={(event) => setModel(event.target.value)}
              />
            </div>
            <div className="space-y-1 sm:col-span-2">
              <Label className="text-xs">{t("verify.change")}</Label>
              <Select
                value={changeId || "none"}
                onValueChange={(value) => setChangeId(value === "none" ? "" : value)}
              >
                <SelectTrigger className="h-7 text-xs" aria-label={t("verify.change")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">{t("verify.noChangeSelected")}</SelectItem>
                  {data.applied.map((change) => (
                    <SelectItem key={change.id} value={change.id}>
                      {`${change.surfaceName} · ${formatDateTime(locale, change.at)}`}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex gap-2 sm:col-span-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={!canRunEval}
                onClick={() => runEval("baseline")}
              >
                {t("verify.runBaseline")}
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={!canRunEval}
                onClick={() => runEval("candidate")}
              >
                {t("verify.runCandidate")}
              </Button>
            </div>
          </div>
        )}
        {evalComparisons.length > 0 && (
          <ul className="space-y-1" data-testid="governance-eval-comparisons">
            {evalComparisons.map((row) => (
              <li key={row.candidate.id} className="flex items-center gap-2 text-[11px]">
                <Badge
                  variant={row.direction === "worse" ? "destructive" : "outline"}
                  className="text-[10px]"
                >
                  {t(`direction.${row.direction}`)}
                </Badge>
                <span className="min-w-0 flex-1 truncate">{`${row.candidate.datasetId} · ${row.candidate.model}`}</span>
                <span className="text-muted-foreground">
                  {t("verify.passRates", {
                    before: percent(row.baseline.passAt1),
                    after: percent(row.candidate.passAt1),
                  })}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
