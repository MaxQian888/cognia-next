"use client"

/**
 * Settings → Observability → Usage & cost.
 *
 * Two things live here, and both were previously unreachable from the UI:
 *
 *  - **Spending ceilings** (ADR-0130). Day and month, global and per-provider.
 *    Distinct from Providers → Routing → `dailyCostBudget`, which is an
 *    advisory routing hint; these are hard and block a send at 100% until a
 *    human approves one more request.
 *  - **The trace debug session.** A time-bounded, local-only capture window.
 *    The old `captureContent` boolean had no expiry, so it was either off (and
 *    nothing was reproducible) or on forever (and every prompt was persisted).
 */

import { useCallback, useMemo, useSyncExternalStore } from "react"
import { useTranslations } from "next-intl"
import { WalletIcon, BugIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { useSettingsStore } from "@/stores/settings"
import {
  armTraceDebugSession,
  disarmTraceDebugSession,
  getTraceDebugSessionServerSnapshot,
  getTraceDebugSessionSnapshot,
  subscribeTraceDebugSession,
  DEFAULT_TRACE_DEBUG_DURATION_MS,
  type TraceDebugSessionSnapshot,
} from "@/lib/observability/debug-session"

/** Minutes offered for a debug session. Bounded by the module's own ceiling. */
const DEBUG_DURATIONS_MINUTES = [15, 30, 60] as const

function positiveOrUndefined(raw: string): number | undefined {
  const value = Number.parseFloat(raw)
  return Number.isFinite(value) && value > 0 ? value : undefined
}

/**
 * Subscribe to the debug session without `useState` + effect, which this repo's
 * `react-hooks/set-state-in-effect` rule forbids. The server snapshot is `null`
 * so the prerendered static export hydrates without divergence.
 */
function useTraceDebugSession(): TraceDebugSessionSnapshot | null {
  // The snapshot must be referentially stable — a fresh object on every read
  // makes React re-render forever.
  return useSyncExternalStore(
    subscribeTraceDebugSession,
    getTraceDebugSessionSnapshot,
    getTraceDebugSessionServerSnapshot
  )
}

export function UsageCostSection() {
  const t = useTranslations("settings.usageCost")
  const settings = useSettingsStore((s) => s.settings)
  const save = useSettingsStore((s) => s.save)
  const debugSession = useTraceDebugSession()

  const budget = useMemo(() => settings?.costBudget ?? {}, [settings?.costBudget])

  const patchBudget = useCallback(
    (patch: Partial<NonNullable<typeof settings>["costBudget"]>) => {
      void save({ costBudget: { ...budget, ...patch } })
    },
    [budget, save]
  )

  // Supplied by the snapshot: reading the clock during render is impure and
  // would tie the countdown to whenever React happened to re-render.
  const remainingMinutes = debugSession?.remainingMinutes ?? 0

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-start gap-3">
            <WalletIcon className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
            <div className="min-w-0">
              <CardTitle className="text-base">{t("budget.title")}</CardTitle>
              <CardDescription className="mt-0.5 text-xs">
                {t("budget.description")}
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="cost-budget-daily" className="text-xs">
                {t("budget.dailyLabel")}
              </Label>
              <Input
                id="cost-budget-daily"
                type="number"
                min={0}
                step="0.01"
                inputMode="decimal"
                placeholder={t("budget.noLimit")}
                aria-label={t("budget.dailyLabel")}
                value={budget.dailyUsd ?? ""}
                onChange={(e) => patchBudget({ dailyUsd: positiveOrUndefined(e.target.value) })}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="cost-budget-monthly" className="text-xs">
                {t("budget.monthlyLabel")}
              </Label>
              <Input
                id="cost-budget-monthly"
                type="number"
                min={0}
                step="0.01"
                inputMode="decimal"
                placeholder={t("budget.noLimit")}
                aria-label={t("budget.monthlyLabel")}
                value={budget.monthlyUsd ?? ""}
                onChange={(e) => patchBudget({ monthlyUsd: positiveOrUndefined(e.target.value) })}
              />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">{t("budget.hardBlockHint")}</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-start gap-3">
            <BugIcon className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
            <div className="min-w-0">
              <CardTitle className="flex items-center gap-2 text-base">
                {t("debug.title")}
                {debugSession ? (
                  <Badge variant="destructive" data-testid="debug-session-active">
                    {t("debug.activeBadge", { minutes: remainingMinutes })}
                  </Badge>
                ) : null}
              </CardTitle>
              <CardDescription className="mt-0.5 text-xs">{t("debug.description")}</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex flex-wrap gap-2">
            {DEBUG_DURATIONS_MINUTES.map((minutes) => (
              <Button
                key={minutes}
                size="sm"
                variant="outline"
                onClick={() => armTraceDebugSession({ durationMs: minutes * 60_000 })}
              >
                {t("debug.armFor", { minutes })}
              </Button>
            ))}
            <Button
              size="sm"
              variant="ghost"
              disabled={!debugSession}
              onClick={() => disarmTraceDebugSession()}
            >
              {t("debug.disarm")}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            {t("debug.privacyHint", {
              minutes: Math.round(DEFAULT_TRACE_DEBUG_DURATION_MS / 60_000),
            })}
          </p>
        </CardContent>
      </Card>
    </div>
  )
}
