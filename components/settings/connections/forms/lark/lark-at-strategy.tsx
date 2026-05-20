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
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Label } from "@/components/ui/label"
import { getDb } from "@/lib/db/schema"
import { updateAdapterInstance } from "@/lib/db/adapter-instances"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"
import {
  DEFAULT_AT_RESPONSE_STRATEGY,
  type AtResponseStrategy,
} from "@/lib/connectors/adapters/lark/at-gate"

const STRATEGIES: AtResponseStrategy[] = ["always", "mention_only", "direct_only"]

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
      </CardContent>
    </Card>
  )
}
