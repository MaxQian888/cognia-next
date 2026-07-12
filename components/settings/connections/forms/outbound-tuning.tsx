"use client"

/**
 * OutboundTuning — shared "outbound throttle & failover" section for every
 * IM adapter's detail panel (multi-bot).
 *
 * Edits `AdapterInstanceRow.outboundTuning` (per-bot token-bucket +
 * circuit-breaker knobs; blank = runner default, see
 * `lib/connectors/outbound-runner.ts:DEFAULT_OUTBOUND_TUNING`) and
 * `AdapterInstanceRow.failoverAdapterIds` (ordered same-platform siblings the
 * runner re-routes a job through when this bot's circuit is open).
 *
 * Same self-managing pattern as `DispatchRules`: takes only `adapterId`,
 * reads the row via `useLiveQuery`, persists immediately through
 * `updateAdapterInstance`, and is mounted ONCE in `config-detail.tsx`.
 */

import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { getDb } from "@/lib/db/schema"
import { updateAdapterInstance } from "@/lib/db/adapter-instances"
import { DEFAULT_OUTBOUND_TUNING } from "@/lib/connectors/outbound-runner"
import type { AdapterInstanceRow, OutboundTuningConfig } from "@/lib/db/connector-types"

type TuningKey = keyof OutboundTuningConfig

const TUNING_FIELDS: Array<{ key: TuningKey; step?: string }> = [
  { key: "rateCapacity" },
  { key: "rateRefillPerSec", step: "0.1" },
  { key: "breakerWindowMs" },
  { key: "breakerMinEvents" },
  { key: "breakerFailureThresholdPct" },
  { key: "breakerCooldownMs" },
]

export interface OutboundTuningProps {
  adapterId: string
}

export function OutboundTuning({ adapterId }: OutboundTuningProps) {
  const t = useTranslations("settings.connections.outboundTuning")

  const row = useLiveQuery<AdapterInstanceRow | undefined>(
    () =>
      typeof window === "undefined"
        ? Promise.resolve(undefined)
        : getDb().adapterInstances.get(adapterId),
    [adapterId]
  )
  // Failover targets: enabled same-platform siblings (the runner skips
  // disabled / muted / cross-platform rows anyway — don't offer them).
  const siblings = useLiveQuery<AdapterInstanceRow[]>(
    () =>
      typeof window === "undefined" || !row?.type
        ? Promise.resolve([])
        : getDb().adapterInstances.where("type").equals(row.type).toArray(),
    [row?.type]
  )
  const candidates = (siblings ?? []).filter((s) => s.id !== adapterId && s.enabled)

  const tuning = row?.outboundTuning ?? {}
  const failoverIds = row?.failoverAdapterIds ?? []
  const balanceIds = row?.balanceAdapterIds ?? []

  const patchTuning = (key: TuningKey, raw: string): void => {
    const parsed = raw.trim() === "" ? undefined : Number(raw)
    const next: OutboundTuningConfig = { ...tuning }
    if (parsed === undefined || !Number.isFinite(parsed)) {
      delete next[key]
    } else {
      next[key] = parsed
    }
    void updateAdapterInstance(adapterId, {
      outboundTuning: Object.keys(next).length > 0 ? next : undefined,
    })
  }

  const toggleFailover = (id: string, on: boolean): void => {
    const next = on
      ? [...failoverIds.filter((f) => f !== id), id]
      : failoverIds.filter((f) => f !== id)
    void updateAdapterInstance(adapterId, {
      failoverAdapterIds: next.length > 0 ? next : undefined,
    })
  }

  const toggleBalance = (id: string, on: boolean): void => {
    const next = on
      ? [...balanceIds.filter((f) => f !== id), id]
      : balanceIds.filter((f) => f !== id)
    void updateAdapterInstance(adapterId, {
      balanceAdapterIds: next.length > 0 ? next : undefined,
    })
  }

  return (
    <Card data-testid="outbound-tuning">
      <CardHeader className="pb-2 pt-3">
        <CardTitle className="text-sm font-medium">{t("title")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-xs text-muted-foreground">{t("help")}</p>

        <div className="grid gap-3 sm:grid-cols-2">
          {TUNING_FIELDS.map(({ key, step }) => (
            <div key={key} className="space-y-1">
              <Label htmlFor={`outbound-tuning-${key}`}>{t(`${key}Label`)}</Label>
              <Input
                id={`outbound-tuning-${key}`}
                className="h-8"
                type="number"
                step={step}
                min={0}
                defaultValue={tuning[key] ?? ""}
                placeholder={String(DEFAULT_OUTBOUND_TUNING[key])}
                onChange={(e) => patchTuning(key, e.target.value)}
                data-testid={`outbound-tuning-${key}`}
              />
            </div>
          ))}
        </div>

        <div className="space-y-2">
          <Label>{t("failoverLabel")}</Label>
          <p className="text-xs text-muted-foreground">{t("failoverHelp")}</p>
          {candidates.length === 0 && (
            <p className="text-xs text-muted-foreground" data-testid="outbound-tuning-no-siblings">
              {t("failoverNoSiblings")}
            </p>
          )}
          {candidates.map((s) => {
            const order = failoverIds.indexOf(s.id)
            return (
              <div key={s.id} className="flex items-center gap-2 text-sm">
                <Switch
                  checked={order >= 0}
                  onCheckedChange={(v) => toggleFailover(s.id, v === true)}
                  aria-label={t("failoverToggleAria", { name: s.displayName })}
                  data-testid={`outbound-tuning-failover-${s.id}`}
                />
                <span>{s.displayName}</span>
                {order >= 0 && (
                  <span className="text-xs text-muted-foreground">
                    {t("failoverOrder", { order: order + 1 })}
                  </span>
                )}
              </div>
            )
          })}
        </div>

        <div className="space-y-2">
          <Label>{t("balanceLabel")}</Label>
          <p className="text-xs text-muted-foreground">{t("balanceHelp")}</p>
          {candidates.length === 0 && (
            <p
              className="text-xs text-muted-foreground"
              data-testid="outbound-tuning-no-balance-siblings"
            >
              {t("failoverNoSiblings")}
            </p>
          )}
          {candidates.map((s) => {
            const order = balanceIds.indexOf(s.id)
            return (
              <div key={s.id} className="flex items-center gap-2 text-sm">
                <Switch
                  checked={order >= 0}
                  onCheckedChange={(v) => toggleBalance(s.id, v === true)}
                  aria-label={t("balanceToggleAria", { name: s.displayName })}
                  data-testid={`outbound-tuning-balance-${s.id}`}
                />
                <span>{s.displayName}</span>
                {order >= 0 && (
                  <span className="text-xs text-muted-foreground">
                    {t("failoverOrder", { order: order + 1 })}
                  </span>
                )}
              </div>
            )
          })}
        </div>
      </CardContent>
    </Card>
  )
}
