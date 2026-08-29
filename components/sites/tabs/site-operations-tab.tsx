"use client"

/**
 * The durable operation journal and the provider's own logs and analytics.
 *
 * These share a tab because they are the only two surfaces in the console with
 * a time axis, and they share one range control. Splitting them would create a
 * tab that stays empty until someone presses a button — which is exactly how
 * observability behaved when it lived inside the old collapsible drawer.
 *
 * The results are rendered as a JSON tree rather than `JSON.stringify` into a
 * `<pre>`, and `logs()`'s `errorsOnly` argument finally has a control.
 */
import { useState } from "react"
import { useTranslations } from "next-intl"
import { InfoIcon } from "lucide-react"

import { JsonTree } from "@/components/shared/json-tree"
import { TimeRangePicker } from "@/components/observability/time-range-picker"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import {
  resolveControlsRange,
  type RangePreset,
  type TimeRange,
} from "@/lib/observability/time-range"
import { siteAnalyticsIsZoneScoped, siteObservabilityHostname } from "@/lib/sites/console-model"
import type { SiteGate } from "@/hooks/sites/use-site-action-gate"
import type {
  SiteDeploymentRow,
  SiteOperationRow,
  SiteProjectRow,
  SiteResourceRow,
} from "@/types/sites"
import { SiteOperationJournal } from "../site-operation-timeline"

type Segment = "operations" | "logs" | "analytics"

const SEGMENTS: Segment[] = ["operations", "logs", "analytics"]

export interface SiteObservabilityQuery {
  kind: "logs" | "analytics"
  range: TimeRange
  errorsOnly: boolean
}

export interface SiteOperationsTabProps {
  site: SiteProjectRow
  operations: readonly SiteOperationRow[]
  resources: readonly SiteResourceRow[]
  deployments: readonly SiteDeploymentRow[]
  gate: SiteGate
  /**
   * Per-key busy predicate from `useSiteActions`. `isBusy(key)` is true while
   * that action is in flight or an exclusive lifecycle action is running; a
   * build no longer disables unrelated controls.
   */
  isBusy: (key?: string) => boolean
  /** Last query result, already unwrapped by the console. */
  result: unknown
  onQuery: (query: SiteObservabilityQuery) => void
  onClearResult: () => void
  onRefreshOperation: (operationId: string) => void
  onCancelOperation: (operationId: string) => void
}

export function SiteOperationsTab({
  site,
  operations,
  resources,
  deployments,
  gate,
  isBusy,
  result,
  onQuery,
  onClearResult,
  onRefreshOperation,
  onCancelOperation,
}: SiteOperationsTabProps) {
  const t = useTranslations("sites")
  const [segment, setSegment] = useState<Segment>("operations")
  const [preset, setPreset] = useState<RangePreset | "custom">("24h")
  const [customSince, setCustomSince] = useState<number | null>(null)
  const [customUntil, setCustomUntil] = useState<number | null>(null)
  const [errorsOnly, setErrorsOnly] = useState(false)

  const hostname = siteObservabilityHostname(resources, deployments)
  const zoneScoped = siteAnalyticsIsZoneScoped(site.providerConfig)

  const runQuery = (kind: "logs" | "analytics") => {
    onQuery({
      kind,
      range: resolveControlsRange(preset, customSince, customUntil),
      errorsOnly,
    })
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3" data-testid="site-operations-tab">
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <ToggleGroup
          type="single"
          value={segment}
          onValueChange={(value) => value && setSegment(value as Segment)}
          variant="outline"
          size="sm"
        >
          {SEGMENTS.map((key) => (
            <ToggleGroupItem key={key} value={key} aria-label={t(`observability.segments.${key}`)}>
              {t(`observability.segments.${key}`)}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>

        {segment !== "operations" ? (
          <>
            <TimeRangePicker
              preset={preset}
              customSince={customSince}
              customUntil={customUntil}
              onPreset={(next) => {
                setPreset(next)
                setCustomSince(null)
                setCustomUntil(null)
              }}
              onCustom={(since, until) => {
                setPreset("custom")
                setCustomSince(since)
                setCustomUntil(until)
              }}
            />
            {segment === "logs" ? (
              <div className="flex items-center gap-1.5">
                <Switch
                  id="site-errors-only"
                  checked={errorsOnly}
                  onCheckedChange={setErrorsOnly}
                />
                <Label htmlFor="site-errors-only" className="text-xs">
                  {t("observability.errorsOnly")}
                </Label>
              </div>
            ) : null}
            <Button
              type="button"
              size="sm"
              className="ml-auto"
              disabled={isBusy(segment) || !gate.allowed}
              title={gate.title}
              onClick={() => runQuery(segment === "logs" ? "logs" : "analytics")}
              data-testid={`site-run-${segment}`}
            >
              {t("actions.runQuery")}
            </Button>
          </>
        ) : null}
      </div>

      {segment === "operations" ? (
        <SiteOperationJournal
          operations={operations}
          onRefresh={onRefreshOperation}
          onCancel={onCancelOperation}
          refreshDisabled={!gate.allowed}
          refreshTitle={gate.title}
        />
      ) : (
        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto">
          {segment === "analytics" ? (
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <InfoIcon aria-hidden className="size-3.5 shrink-0" />
              {hostname ? t("observability.hostname", { hostname }) : t("observability.noHostname")}
              {hostname && !zoneScoped ? ` · ${t("observability.workerScoped")}` : null}
            </p>
          ) : null}

          <div className="rounded-xl border">
            <div className="flex items-center gap-2 border-b bg-muted/40 px-3 py-1.5">
              <span className="min-w-0 flex-1 truncate text-xs font-medium">
                {t("observability.result")}
              </span>
              <Button
                type="button"
                size="xs"
                variant="ghost"
                disabled={result === undefined}
                onClick={onClearResult}
              >
                {t("actions.clearOutput")}
              </Button>
            </div>
            <div
              className="max-h-[50vh] overflow-auto p-3 text-xs"
              data-testid="site-observability-result"
            >
              {result === undefined ? (
                <p className="text-muted-foreground">{t("observability.empty")}</p>
              ) : (
                <JsonTree value={result} />
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
