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
 *
 * The policy in `lib/usage/cost-budget.ts` has always supported four scopes
 * (day/month x global/per-provider) plus tunable warn/critical thresholds, and
 * the send gate has always enforced all of them. This editor only ever exposed
 * the two global ceilings, so the per-provider caps and the thresholds were
 * live code no user could reach. All four scopes are editable here now, and the
 * spend against them is rendered by the shared `UsageBudgetMeters`, which the
 * Usage dashboard mounts as well.
 */

import { useCallback, useMemo, useState, useSyncExternalStore } from "react"
import { useTranslations } from "next-intl"
import { WalletIcon, BugIcon, GaugeIcon, PlusIcon, XIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { UsageBudgetMeters } from "@/components/usage/usage-budget-meters"
import { useCostBudgetStatus } from "@/hooks/usage/use-cost-budget-status"
import { useSettingsStore } from "@/stores/settings"
import { BUILT_IN_PROVIDER_IDS } from "@cognia/provider-types/built-in-provider-catalog"
import { DEFAULT_CRITICAL_AT, DEFAULT_WARN_AT } from "@/lib/usage/cost-budget"
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

type BudgetPolicy = NonNullable<
  NonNullable<ReturnType<typeof useSettingsStore.getState>["settings"]>["costBudget"]
>

function positiveOrUndefined(raw: string): number | undefined {
  const value = Number.parseFloat(raw)
  return Number.isFinite(value) && value > 0 ? value : undefined
}

/**
 * Read a percent field back as the 0-1 ratio the policy stores. Out-of-range
 * input collapses to `undefined` (meaning "use the default") rather than being
 * clamped, because silently rewriting "150" to "100" would tell the user their
 * typo had been accepted.
 */
function ratioOrUndefined(raw: string): number | undefined {
  const value = Number.parseFloat(raw)
  if (!Number.isFinite(value) || value <= 0 || value >= 100) return undefined
  return value / 100
}

function ratioAsPercentField(ratio: number | undefined): string {
  return typeof ratio === "number" && Number.isFinite(ratio) ? String(Math.round(ratio * 100)) : ""
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

  const budget = useMemo<BudgetPolicy>(() => settings?.costBudget ?? {}, [settings?.costBudget])

  const patchBudget = useCallback(
    (patch: Partial<BudgetPolicy>) => {
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
          <p className="text-xs text-muted-foreground">
            {t("budget.hardBlockHint", {
              warn: Math.round((budget.warnAt ?? DEFAULT_WARN_AT) * 100),
              critical: Math.round((budget.criticalAt ?? DEFAULT_CRITICAL_AT) * 100),
            })}
          </p>

          <PerProviderBudgets budget={budget} onPatch={patchBudget} />

          <ThresholdFields budget={budget} onPatch={patchBudget} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-start gap-3">
            <GaugeIcon className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
            <div className="min-w-0">
              <CardTitle className="text-base">{t("spend.title")}</CardTitle>
              <CardDescription className="mt-0.5 text-xs">{t("spend.description")}</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <UsageBudgetMeters emptyHint={t("spend.empty")} />
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

/* ── Per-provider ceilings ─────────────────────────────────────────────── */

/**
 * A row per provider that either already has a ceiling or has spent something
 * this month, plus a picker for the rest.
 *
 * Listing every known provider up front would be a wall of empty inputs, and
 * listing only the configured ones would hide the provider you actually want
 * to cap. Spend is the signal that a provider is worth capping, so the two
 * sources are unioned.
 */
function PerProviderBudgets({
  budget,
  onPatch,
}: {
  budget: BudgetPolicy
  onPatch: (patch: Partial<BudgetPolicy>) => void
}) {
  const t = useTranslations("settings.usageCost")
  const { spend } = useCostBudgetStatus()
  const customProviders = useSettingsStore((s) => s.settings?.customProviders)
  // Providers the user picked but has not given a number to yet. They vanish on
  // reload, which is correct: an empty row is not a setting.
  const [pending, setPending] = useState<string[]>([])

  const rows = useMemo(() => {
    const ids = new Set<string>([
      ...Object.keys(budget.perProviderDailyUsd ?? {}),
      ...Object.keys(budget.perProviderMonthlyUsd ?? {}),
      ...Object.keys(spend?.byProviderMonthUsd ?? {}),
      ...pending,
    ])
    return [...ids].sort((a, b) => a.localeCompare(b))
  }, [budget.perProviderDailyUsd, budget.perProviderMonthlyUsd, spend, pending])

  const candidates = useMemo(() => {
    const known = new Set<string>([
      ...BUILT_IN_PROVIDER_IDS,
      ...(customProviders ?? []).map((provider) => provider.id),
    ])
    for (const id of rows) known.delete(id)
    return [...known].sort((a, b) => a.localeCompare(b))
  }, [customProviders, rows])

  const patchProvider = (
    field: "perProviderDailyUsd" | "perProviderMonthlyUsd",
    provider: string,
    value: number | undefined
  ): void => {
    const next = { ...(budget[field] ?? {}) }
    // An absent key and a key holding `undefined` mean the same thing to the
    // policy, but only the deletion round-trips cleanly through settings sync.
    if (value === undefined) delete next[provider]
    else next[provider] = value
    onPatch({ [field]: Object.keys(next).length > 0 ? next : undefined } as Partial<BudgetPolicy>)
  }

  const removeProvider = (provider: string): void => {
    setPending((prev) => prev.filter((id) => id !== provider))
    const daily = { ...(budget.perProviderDailyUsd ?? {}) }
    const monthly = { ...(budget.perProviderMonthlyUsd ?? {}) }
    delete daily[provider]
    delete monthly[provider]
    onPatch({
      perProviderDailyUsd: Object.keys(daily).length > 0 ? daily : undefined,
      perProviderMonthlyUsd: Object.keys(monthly).length > 0 ? monthly : undefined,
    })
  }

  return (
    <div className="flex flex-col gap-2 border-t pt-4" data-testid="cost-budget-per-provider">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-medium">{t("budget.perProviderTitle")}</p>
          <p className="text-xs text-muted-foreground">{t("budget.perProviderDescription")}</p>
        </div>
        {candidates.length > 0 && (
          // A menu, not a Select: this picks an ACTION (add a row), it does not
          // hold a value. A controlled Select whose value never matches an item
          // renders an empty trigger, which is the wrong affordance here.
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" data-testid="cost-budget-add-provider">
                <PlusIcon className="size-3.5" aria-hidden />
                {t("budget.addProvider")}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="max-h-72 overflow-y-auto">
              {candidates.map((id) => (
                <DropdownMenuItem
                  key={id}
                  onClick={() => setPending((prev) => [...prev, id])}
                  data-testid={`cost-budget-add-provider-${id}`}
                >
                  {id}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground" data-testid="cost-budget-per-provider-empty">
          {t("budget.perProviderEmpty")}
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {rows.map((provider) => (
            <li
              key={provider}
              className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-2 sm:grid-cols-[minmax(6rem,9rem)_minmax(0,1fr)_minmax(0,1fr)_auto]"
              data-testid={`cost-budget-provider-${provider}`}
            >
              <span className="min-w-0 truncate pb-2 font-mono text-xs">{provider}</span>
              <div className="flex min-w-0 flex-col gap-1">
                <Label htmlFor={`budget-${provider}-daily`} className="text-[10px]">
                  {t("budget.dailyShort")}
                </Label>
                <Input
                  id={`budget-${provider}-daily`}
                  type="number"
                  min={0}
                  step="0.01"
                  inputMode="decimal"
                  className="h-8"
                  placeholder={t("budget.noLimit")}
                  aria-label={t("budget.perProviderDailyLabel", { provider })}
                  value={budget.perProviderDailyUsd?.[provider] ?? ""}
                  onChange={(e) =>
                    patchProvider(
                      "perProviderDailyUsd",
                      provider,
                      positiveOrUndefined(e.target.value)
                    )
                  }
                />
              </div>
              <div className="flex min-w-0 flex-col gap-1">
                <Label htmlFor={`budget-${provider}-monthly`} className="text-[10px]">
                  {t("budget.monthlyShort")}
                </Label>
                <Input
                  id={`budget-${provider}-monthly`}
                  type="number"
                  min={0}
                  step="0.01"
                  inputMode="decimal"
                  className="h-8"
                  placeholder={t("budget.noLimit")}
                  aria-label={t("budget.perProviderMonthlyLabel", { provider })}
                  value={budget.perProviderMonthlyUsd?.[provider] ?? ""}
                  onChange={(e) =>
                    patchProvider(
                      "perProviderMonthlyUsd",
                      provider,
                      positiveOrUndefined(e.target.value)
                    )
                  }
                />
              </div>
              <Button
                variant="ghost"
                size="icon"
                className="size-8"
                onClick={() => removeProvider(provider)}
                title={t("budget.removeProvider", { provider })}
                aria-label={t("budget.removeProvider", { provider })}
                data-testid={`cost-budget-remove-${provider}`}
              >
                <XIcon className="size-3.5" aria-hidden />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/* ── Warn / critical thresholds ────────────────────────────────────────── */

/**
 * The two ratios that decide when a notification fires. They were policy fields
 * with defaults and no editor, so every install warned at exactly 80 and 95.
 */
function ThresholdFields({
  budget,
  onPatch,
}: {
  budget: BudgetPolicy
  onPatch: (patch: Partial<BudgetPolicy>) => void
}) {
  const t = useTranslations("settings.usageCost")
  return (
    <div className="flex flex-col gap-2 border-t pt-4" data-testid="cost-budget-thresholds">
      <div className="min-w-0">
        <p className="text-sm font-medium">{t("budget.thresholdsTitle")}</p>
        <p className="text-xs text-muted-foreground">{t("budget.thresholdsDescription")}</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="cost-budget-warn-at" className="text-xs">
            {t("budget.warnAtLabel")}
          </Label>
          <Input
            id="cost-budget-warn-at"
            type="number"
            min={1}
            max={99}
            step="1"
            inputMode="numeric"
            placeholder={String(Math.round(DEFAULT_WARN_AT * 100))}
            aria-label={t("budget.warnAtLabel")}
            value={ratioAsPercentField(budget.warnAt)}
            onChange={(e) => onPatch({ warnAt: ratioOrUndefined(e.target.value) })}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="cost-budget-critical-at" className="text-xs">
            {t("budget.criticalAtLabel")}
          </Label>
          <Input
            id="cost-budget-critical-at"
            type="number"
            min={1}
            max={99}
            step="1"
            inputMode="numeric"
            placeholder={String(Math.round(DEFAULT_CRITICAL_AT * 100))}
            aria-label={t("budget.criticalAtLabel")}
            value={ratioAsPercentField(budget.criticalAt)}
            onChange={(e) => onPatch({ criticalAt: ratioOrUndefined(e.target.value) })}
          />
        </div>
      </div>
    </div>
  )
}
