"use client"

// "What would the next send pick?" — pure preview through the
// SAME engine + live telemetry stores the chat send path uses.

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { FlaskConical } from "lucide-react"

import { useSettingsStore } from "@/stores/settings"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { buildRoutingEngine } from "@cognia/provider-routing/build-preview-engine"
import { FallbackChainView } from "./fallback-chain-view"
import { RoutingNoCandidatesError } from "@cognia/provider-routing/provider-routing-engine"
import type { RoutingPlan } from "@cognia/provider-types/auto-router"
import { DEFAULT_AUTO_ROUTING, type AutoRoutingSettings } from "@cognia/provider-types/auto-router"
import { analyzeRoutingCalibration, type RoutingCalibrationResult } from "@/lib/routing/calibration"

type PreviewState = RoutingPlan | null | "none" | { noCandidates: string }

export function RoutingTestPanel() {
  const t = useTranslations("providers.routingView")
  const settings = useSettingsStore((s) => s.settings)
  const save = useSettingsStore((s) => s.save)
  const [alias, setAlias] = useState("")
  const [promptText, setPromptText] = useState("")
  const [auto, setAuto] = useState(false)
  const [result, setResult] = useState<PreviewState>("none")
  const [calibration, setCalibration] = useState<RoutingCalibrationResult | null>(null)
  const localizeReasonCode = (code: string) => {
    if (code.startsWith("plugin:")) return t("reasonCode.plugin", { code })
    if (code.startsWith("filter:")) return t("reasonCode.filter", { code })
    return t(`reasonCode.${code}` as never)
  }

  useEffect(() => {
    let active = true
    void import("@/lib/db/agent-traces")
      .then(({ queryRecent }) => queryRecent(1_000))
      .then((spans) => {
        if (!active) return
        setCalibration(
          analyzeRoutingCalibration(
            spans,
            settings?.autoRouting?.thresholds ?? DEFAULT_AUTO_ROUTING.thresholds
          )
        )
      })
      .catch(() => {
        if (active) setCalibration(null)
      })
    return () => {
      active = false
    }
  }, [settings?.autoRouting?.thresholds])

  const applyCalibration = () => {
    if (!settings || !calibration?.recommendedThresholds) return
    const autoRouting: AutoRoutingSettings = {
      ...DEFAULT_AUTO_ROUTING,
      ...(settings.autoRouting ?? {}),
      thresholds: calibration.recommendedThresholds,
    }
    void save({ autoRouting })
  }

  const runPreview = async () => {
    if ((!auto && !alias.trim()) || !settings) return
    const engine = buildRoutingEngine(settings)
    try {
      setResult(
        await engine.planRoute({
          surface: "chat",
          selection: auto ? { kind: "auto" } : { kind: "alias", alias: alias.trim() },
          promptText,
          candidateAliases: settings.autoRouting?.candidateAliases,
          thresholds: settings.autoRouting?.thresholds,
          strategy: settings.routingConfig?.strategy,
          dataPolicy: settings.autoRouting?.dataPolicy,
          shadowMode: settings.autoRouting?.shadowMode,
        })
      )
    } catch (err) {
      // Alias matched but the filter chain emptied the candidate set — show
      // the dedicated "no viable provider" state instead of crashing.
      if (err instanceof RoutingNoCandidatesError) {
        setResult({ noCandidates: err.alias })
      } else {
        setResult(null)
      }
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Input
          value={alias}
          placeholder={t("testAliasPlaceholder")}
          aria-label={t("testAliasPlaceholder")}
          className="h-8 font-mono text-xs"
          onChange={(e) => setAlias(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void runPreview()
          }}
          disabled={auto}
        />
        <Button
          size="sm"
          variant={auto ? "default" : "outline"}
          className="h-8 shrink-0 text-xs"
          onClick={() => setAuto((value) => !value)}
        >
          {t("autoMode")}
        </Button>
        <Button size="sm" className="h-8 shrink-0 text-xs" onClick={() => void runPreview()}>
          <FlaskConical className="mr-1 h-3 w-3" />
          {t("runPreview")}
        </Button>
      </div>
      <Input
        value={promptText}
        placeholder={t("testPromptPlaceholder")}
        aria-label={t("testPromptPlaceholder")}
        className="h-8 text-xs"
        onChange={(event) => setPromptText(event.target.value)}
      />
      {calibration ? (
        <div
          className="space-y-1.5 rounded-md border border-dashed px-2.5 py-2 text-[10px] text-muted-foreground"
          data-testid="routing-calibration"
        >
          <p>
            {t(
              calibration.status === "ready"
                ? "calibrationReady"
                : calibration.status === "insufficient-tier"
                  ? "calibrationNeedTiers"
                  : "calibrationNeedSamples",
              {
                count: calibration.sampleSize,
                confidence: Math.round(calibration.confidence * 100),
                fast: calibration.perTier.fast,
                balanced: calibration.perTier.balanced,
                powerful: calibration.perTier.powerful,
              }
            )}
          </p>
          {calibration.recommendedThresholds ? (
            <div className="flex items-center justify-between gap-2">
              <span>
                {t("calibrationThresholds", {
                  balanced: calibration.recommendedThresholds.balanced,
                  powerful: calibration.recommendedThresholds.powerful,
                })}
              </span>
              <Button
                size="sm"
                variant="outline"
                className="h-6 px-2 text-[10px]"
                onClick={applyCalibration}
              >
                {t("calibrationApply")}
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}

      {result !== "none" ? (
        result !== null && typeof result === "object" && "noCandidates" in result ? (
          <p className="text-xs text-destructive" data-testid="preview-no-candidates">
            {t("noViableProvider", { alias: result.noCandidates })}
          </p>
        ) : result === null ? (
          <p className="text-xs text-muted-foreground" data-testid="preview-no-match">
            {t("noMatch")}
          </p>
        ) : (
          <div
            className="space-y-2 rounded-lg border bg-muted/30 px-3 py-2.5"
            data-testid="preview-result"
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-muted-foreground">{t("resolvedTo")}</span>
              <Badge className="font-mono text-[10px]">
                {result.selected.providerId}:{result.selected.modelId}
              </Badge>
              <Badge variant="outline" className="text-[10px]">
                {t(`strategy.${result.strategy}`)}
              </Badge>
            </div>
            {result.orderedCandidates.length > 1 ? (
              <div className="space-y-1">
                <p className="text-[10px] text-muted-foreground">{t("fallbackChain")}</p>
                <FallbackChainView entries={result.orderedCandidates} />
              </div>
            ) : null}
            {result.filterNotes?.prunedBy?.length ||
            result.filterNotes?.affinityPinned ||
            result.reasonCodes.length ? (
              <div className="flex flex-wrap items-center gap-1.5" data-testid="preview-notes">
                {result.filterNotes?.affinityPinned ? (
                  <Badge variant="outline" className="text-[10px]">
                    {t("affinityPinnedBadge")}
                  </Badge>
                ) : null}
                {(result.filterNotes?.prunedBy ?? []).map((id) => (
                  <Badge key={id} variant="outline" className="text-[10px] text-muted-foreground">
                    {t("prunedByBadge", { filter: id })}
                  </Badge>
                ))}
                {result.reasonCodes.map((code) => (
                  <Badge key={code} variant="outline" className="text-[10px]">
                    {localizeReasonCode(code)}
                  </Badge>
                ))}
              </div>
            ) : null}
            {result.classification ? (
              <p className="text-[10px] text-muted-foreground">
                {t("classificationSummary", {
                  category: t(`taskCategory.${result.classification.category}`),
                  complexity: t(`taskComplexity.${result.classification.complexity}`),
                })}
              </p>
            ) : null}
            {result.shadowComparison ? (
              <p className="text-[10px] text-muted-foreground">
                {t(result.shadowComparison.differs ? "shadowDiff" : "shadowMatch", {
                  provider: result.shadowComparison.selected.providerId,
                  model: result.shadowComparison.selected.modelId,
                })}
              </p>
            ) : null}
            {result.rejected.map(({ reasonCode, count }) => (
              <p key={reasonCode} className="text-[10px] text-muted-foreground">
                {t("rejectedSummary", { reason: localizeReasonCode(reasonCode), count })}
              </p>
            ))}
          </div>
        )
      ) : null}
    </div>
  )
}

export default RoutingTestPanel
