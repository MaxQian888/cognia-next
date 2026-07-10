"use client"

/**
 * Lark at-strategy radio (im-refactored-crayon).
 *
 * Persists `adapterInstances.atResponseStrategy` for the row. The
 * inbound at-gate (`lib/connectors/adapters/lark/at-gate.ts`) reads
 * this on every message to decide whether to respond.
 *
 *   - `always`        — respond to every inbound message in scope
 *   - `mention_only`  — respond only when the bot is @-mentioned (default)
 *   - `direct_only`   — only respond in 1:1 DMs
 *
 * DMs always bypass `mention_only` because there is no mention surface.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Label } from "@/components/ui/label"
import { getDb } from "@/lib/db/schema"
import { updateAdapterInstance } from "@/lib/db/adapter-instances"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"
import {
  DEFAULT_AT_RESPONSE_STRATEGY,
  DEFAULT_BOT_INTERPLAY_BUDGET,
  type AtResponseStrategy,
} from "@/lib/connectors/adapters/lark/at-gate"

const STRATEGIES: AtResponseStrategy[] = ["always", "mention_only", "direct_only"]

type SiblingBotPolicy = NonNullable<AdapterInstanceRow["siblingBotPolicy"]>

const SIBLING_POLICIES: SiblingBotPolicy[] = ["ignore", "respond"]

export interface LarkAtStrategyProps {
  adapterId: string
}

export function LarkAtStrategy({ adapterId }: LarkAtStrategyProps) {
  const t = useTranslations("settings.connections.lark.atStrategy")
  const [saving, setSaving] = useState(false)

  const row = useLiveQuery<AdapterInstanceRow | undefined>(
    () =>
      typeof window === "undefined"
        ? Promise.resolve(undefined)
        : getDb().adapterInstances.get(adapterId),
    [adapterId]
  )

  const current: AtResponseStrategy = row?.atResponseStrategy ?? DEFAULT_AT_RESPONSE_STRATEGY
  const siblingPolicy: SiblingBotPolicy = row?.siblingBotPolicy ?? "ignore"

  const onChange = async (value: string) => {
    if (!STRATEGIES.includes(value as AtResponseStrategy)) return
    setSaving(true)
    try {
      await updateAdapterInstance(adapterId, {
        atResponseStrategy: value as AtResponseStrategy,
      })
    } finally {
      setSaving(false)
    }
  }

  const onSiblingPolicyChange = async (value: string) => {
    if (!SIBLING_POLICIES.includes(value as SiblingBotPolicy)) return
    setSaving(true)
    try {
      await updateAdapterInstance(adapterId, {
        siblingBotPolicy: value as SiblingBotPolicy,
      })
    } finally {
      setSaving(false)
    }
  }

  const onBudgetChange = async (raw: string) => {
    const parsed = Number.parseInt(raw, 10)
    if (!Number.isInteger(parsed) || parsed < 1) return
    setSaving(true)
    try {
      await updateAdapterInstance(adapterId, { botInterplayBudget: parsed })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card data-testid="lark-at-strategy">
      <CardHeader className="pb-2 pt-3">
        <CardTitle className="text-sm font-medium">{t("title")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">{t("help")}</p>
        <RadioGroup value={current} onValueChange={(v) => void onChange(v)} disabled={saving}>
          {STRATEGIES.map((value) => {
            const key =
              value === "mention_only"
                ? "mentionOnly"
                : value === "direct_only"
                  ? "directOnly"
                  : value
            return (
              <div key={value} className="flex items-start gap-2">
                <RadioGroupItem
                  value={value}
                  id={`lark-at-${value}`}
                  data-testid={`lark-at-${value}`}
                />
                <div className="flex-1 space-y-0.5">
                  <Label htmlFor={`lark-at-${value}`} className="cursor-pointer">
                    {t(`options.${key}`)}
                  </Label>
                </div>
              </div>
            )
          })}
        </RadioGroup>
        {!row?.atResponseStrategy && (
          <p className="text-xs text-muted-foreground italic">{t("defaultNotice")}</p>
        )}

        {/* ── Sibling-bot policy (W5 multi-bot same-group) ── */}
        <div className="space-y-2 border-t pt-3">
          <p className="text-sm font-medium">{t("sibling.title")}</p>
          <p className="text-xs text-muted-foreground">{t("sibling.help")}</p>
          <RadioGroup
            value={siblingPolicy}
            onValueChange={(v) => void onSiblingPolicyChange(v)}
            disabled={saving}
          >
            {SIBLING_POLICIES.map((value) => (
              <div key={value} className="flex items-start gap-2">
                <RadioGroupItem
                  value={value}
                  id={`sibling-policy-${value}`}
                  data-testid={`sibling-policy-${value}`}
                />
                <div className="flex-1 space-y-0.5">
                  <Label htmlFor={`sibling-policy-${value}`} className="cursor-pointer">
                    {t(`sibling.options.${value}`)}
                  </Label>
                </div>
              </div>
            ))}
          </RadioGroup>
          {siblingPolicy === "respond" && (
            <div className="space-y-1">
              <Label htmlFor="sibling-budget" className="text-xs">
                {t("sibling.budgetLabel")}
              </Label>
              <Input
                id="sibling-budget"
                data-testid="sibling-budget-input"
                type="number"
                min={1}
                className="h-8 w-24"
                defaultValue={row?.botInterplayBudget ?? DEFAULT_BOT_INTERPLAY_BUDGET}
                onChange={(e) => void onBudgetChange(e.target.value)}
                aria-label={t("sibling.budgetAria")}
              />
              <p className="text-xs text-muted-foreground">{t("sibling.budgetHelp")}</p>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
