"use client"

/**
 * The routing experiment panel (ADR-0188 B6) — the user path into everything
 * WP-F2 builds: collect samples from routed runs, export them with their
 * propensity, train and gate a learned router, watch it shadow the rules
 * router, promote it, and put it back.
 *
 * It renders nothing but a "Router + Fusion is off" card while every surface is
 * off, and the engine under `lib/router-fusion/eval/` is reached only through
 * `lib/ai/eval/routing-experiment.ts`, which imports it dynamically behind the
 * same check — so a user who never turned Router + Fusion on never loads a byte
 * of the experiment.
 *
 * ROLE 7 DORMANCY. Promotion is real — the manifest is sealed, the pointer
 * moves, rollback restores it — but a promoted predictor does not yet change a
 * routing decision: nothing wires it into `routing/run-route.ts`. The panel
 * says so on the promotion card rather than implying a promotion takes effect,
 * and `routing-experiment-panel.test.tsx` pins that the note is shown.
 */

import { useCallback, useEffect, useState } from "react"
import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  openRoutingEvalWorkspace,
  routingExperimentAvailable,
  runSimulatedRoutingExperiment,
  type RoutingEvalWorkspace,
  type RoutingExperimentResult,
  type RoutingPromotionOutcome,
  type RoutingSampleExport,
  type ShadowRunOutcome,
} from "@/lib/ai/eval/routing-experiment"
import type { FusionPredictorManifestRow } from "@/lib/router-fusion/db/types"
import { useSettingsStore } from "@/stores/settings"

import { RoutingReportSummary, formatShare } from "./routing-report-summary"

/** Fixed so two runs of the same samples produce the same report. */
export const ROUTING_EXPERIMENT_SEED = 1

export interface RoutingExperimentPanelProps {
  /** Injected by tests; defaults to the real, database-backed workspace. */
  openWorkspace?: typeof openRoutingEvalWorkspace
  /** Injected by tests; defaults to the real generator. */
  runSimulated?: typeof runSimulatedRoutingExperiment
  /** Where an export goes. Defaults to a download in the browser. */
  onExport?: (document: RoutingSampleExport) => void | Promise<void>
}

function downloadExport(document_: RoutingSampleExport): void {
  const blob = new Blob([JSON.stringify(document_, null, 2)], { type: "application/json" })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement("a")
  anchor.href = url
  anchor.download = `routing-samples-${document_.label}.json`
  anchor.click()
  URL.revokeObjectURL(url)
}

export function RoutingExperimentPanel({
  openWorkspace = openRoutingEvalWorkspace,
  runSimulated = runSimulatedRoutingExperiment,
  onExport = downloadExport,
}: RoutingExperimentPanelProps) {
  const t = useTranslations("routerFusionEval")
  const available = useSettingsStore((state) => routingExperimentAvailable(state.settings))

  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [sampleCount, setSampleCount] = useState<number | null>(null)
  const [result, setResult] = useState<RoutingExperimentResult | null>(null)
  const [shadow, setShadow] = useState<ShadowRunOutcome | null>(null)
  const [active, setActive] = useState<FusionPredictorManifestRow | null>(null)
  const [applicationId, setApplicationId] = useState<string | null>(null)

  const withWorkspace = useCallback(
    async (work: (workspace: RoutingEvalWorkspace) => Promise<void>) => {
      setBusy(true)
      setError(null)
      try {
        const workspace = await openWorkspace(useSettingsStore.getState().settings)
        await work(workspace)
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        setBusy(false)
      }
    },
    [openWorkspace]
  )

  useEffect(() => {
    if (!available) return
    let cancelled = false
    void (async () => {
      try {
        const workspace = await openWorkspace(useSettingsStore.getState().settings)
        const [samples, activeRow] = await Promise.all([
          workspace.listSamples(),
          workspace.activeManifest(),
        ])
        if (cancelled) return
        setSampleCount(samples.length)
        setActive(activeRow ?? null)
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [available, openWorkspace])

  const collect = useCallback(
    () =>
      withWorkspace(async (workspace) => {
        const collected = await workspace.collect()
        const samples = await workspace.listSamples()
        setSampleCount(samples.length)
        setNotice(
          t("samples.collected", { count: collected.collected, scanned: collected.scanned })
        )
      }),
    [t, withWorkspace]
  )

  const exportSamples = useCallback(
    () =>
      withWorkspace(async (workspace) => {
        const exported = await workspace.exportSamples()
        await onExport(exported)
        setNotice(t("samples.exported", { count: exported.sampleCount }))
      }),
    [onExport, t, withWorkspace]
  )

  const runRecorded = useCallback(
    () =>
      withWorkspace(async (workspace) => {
        setResult(
          await workspace.runExperiment({
            seed: ROUTING_EXPERIMENT_SEED,
            createdAt: new Date().toISOString(),
          })
        )
        setApplicationId(null)
        setNotice(null)
      }),
    [withWorkspace]
  )

  const runFake = useCallback(async () => {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      setResult(
        await runSimulated({
          seed: ROUTING_EXPERIMENT_SEED,
          createdAt: new Date().toISOString(),
        })
      )
      setApplicationId(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }, [runSimulated])

  const runShadow = useCallback(
    () =>
      withWorkspace(async (workspace) => {
        setShadow(await workspace.shadow())
      }),
    [withWorkspace]
  )

  const promote = useCallback(
    () =>
      withWorkspace(async (workspace) => {
        if (!result) return
        const outcome: RoutingPromotionOutcome = await workspace.promote(result)
        if (outcome.status === "refused") {
          setNotice(outcome.refusals.map((refusal) => t(`promotion.refused.${refusal}`)).join(" "))
          return
        }
        setApplicationId(outcome.applicationId)
        setActive((await workspace.activeManifest()) ?? null)
        setNotice(t("promotion.promoted", { version: outcome.manifestSha256.slice(0, 16) }))
      }),
    [result, t, withWorkspace]
  )

  const rollback = useCallback(
    () =>
      withWorkspace(async (workspace) => {
        const outcome = await workspace.rollback(applicationId ?? undefined)
        setApplicationId(null)
        setActive((await workspace.activeManifest()) ?? null)
        setNotice(
          outcome.status === "rolled_back"
            ? t("promotion.rolledBack")
            : outcome.status === "deactivated"
              ? t("promotion.deactivated")
              : outcome.message
        )
      }),
    [applicationId, t, withWorkspace]
  )

  if (!available) {
    return (
      <Card data-testid="routing-experiment-unavailable">
        <CardHeader>
          <CardTitle className="text-sm">{t("unavailable.title")}</CardTitle>
        </CardHeader>
        <CardContent className="text-muted-foreground text-sm">{t("unavailable.body")}</CardContent>
      </Card>
    )
  }

  const busyLabel = busy ? t("actions.busy") : null

  return (
    <div className="space-y-4 p-4" data-testid="routing-experiment-panel">
      <header>
        <h2 className="text-sm font-medium">{t("title")}</h2>
        <p className="text-muted-foreground text-xs">{t("subtitle")}</p>
      </header>

      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" disabled={busy} onClick={collect}>
          {t("actions.collect")}
        </Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={exportSamples}>
          {t("actions.export")}
        </Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={runFake}>
          {t("actions.runSimulated")}
        </Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={runRecorded}>
          {t("actions.runRecorded")}
        </Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={runShadow}>
          {t("actions.shadow")}
        </Button>
      </div>

      {busyLabel && (
        <p className="text-muted-foreground text-xs" role="status">
          {busyLabel}
        </p>
      )}
      {error && (
        <p className="text-destructive text-xs" role="alert" data-testid="routing-experiment-error">
          {t("errors.failed", { message: error })}
        </p>
      )}
      {notice && (
        <p className="text-xs" role="status" data-testid="routing-experiment-notice">
          {notice}
        </p>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">{t("samples.title")}</CardTitle>
        </CardHeader>
        <CardContent className="text-sm">
          {t("samples.stored", { count: sampleCount ?? 0 })}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">{t("report.title")}</CardTitle>
        </CardHeader>
        <CardContent>
          {result ? (
            <RoutingReportSummary report={result.report} />
          ) : (
            <p className="text-muted-foreground text-sm">{t("report.empty")}</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">{t("shadow.title")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1 text-sm">
          <p className="text-muted-foreground text-xs">{t("shadow.note")}</p>
          {shadow === null && <p>{t("shadow.empty")}</p>}
          {shadow?.status === "no_predictor" && <p>{t("shadow.noPredictor")}</p>}
          {shadow?.status === "predictor_refused" && <p>{t("shadow.refused")}</p>}
          {shadow?.status === "no_samples" && <p>{t("shadow.empty")}</p>}
          {shadow?.status === "recorded" && (
            <p data-testid="routing-shadow-summary">
              {t("shadow.evaluated")}: {shadow.summary.evaluated} · {t("shadow.agreement")}:{" "}
              {formatShare(shadow.summary.agreementRate) ?? "—"} · {t("shadow.outOfDistribution")}:{" "}
              {shadow.summary.outOfDistribution}
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">{t("promotion.title")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <p>
            {t("promotion.active")}:{" "}
            <span data-testid="routing-active-predictor">
              {active ? active.manifestSha256.slice(0, 16) : t("promotion.none")}
            </span>
          </p>
          <p className="text-muted-foreground text-xs" data-testid="routing-promotion-dormancy">
            {t("promotion.dormant")}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" disabled={busy || !result} onClick={promote}>
              {t("actions.promote")}
            </Button>
            <Button size="sm" variant="outline" disabled={busy || !active} onClick={rollback}>
              {t("actions.rollback")}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
