"use client"

/**
 * Run-operator allowlist (plan 2026-07-24 Phase 2).
 *
 * `AdapterInstanceRow.settings.runOperatorUserIds` had three readers and no
 * writer: the callback authorization guard (`operators` actor scope), the
 * Execution Run control gate, and follow-up control all consult it, and the
 * denial notice tells the clicker "only the requester or a configured operator
 * can" — for a list nothing in the product could configure.
 *
 * That is not cosmetic. `approvalActorScope` falls back to `{mode:"operators"}`
 * when a workflow approval card has no known requester, so an empty list means
 * those cards can never be actioned by anyone.
 *
 * Platform-neutral by design: every adapter's guard reads the same field, and
 * the ids are whatever the platform reports as the inbound sender id.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { getDb } from "@/lib/db/schema"
import { patchAdapterInstanceSettings } from "@/lib/db/adapter-instances"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"

export interface RunOperatorsProps {
  adapterId: string
}

/** Split on commas/whitespace, drop blanks, de-duplicate, preserve order. */
export function parseOperatorIds(raw: string): string[] {
  const seen = new Set<string>()
  const ids: string[] = []
  for (const token of raw.split(/[,\s]+/)) {
    const id = token.trim()
    if (!id || seen.has(id)) continue
    seen.add(id)
    ids.push(id)
  }
  return ids
}

export function RunOperators({ adapterId }: RunOperatorsProps) {
  const t = useTranslations("settings.connections.runOperators")
  const [draft, setDraft] = useState<{ adapterId: string; value: string } | null>(null)

  const row = useLiveQuery<AdapterInstanceRow | undefined>(
    () =>
      typeof window === "undefined"
        ? Promise.resolve(undefined)
        : getDb().adapterInstances.get(adapterId),
    [adapterId]
  )

  const stored = Array.isArray(row?.settings.runOperatorUserIds)
    ? (row.settings.runOperatorUserIds as unknown[]).filter(
        (value): value is string => typeof value === "string"
      )
    : []
  const storedText = stored.join(", ")

  const commit = (raw: string) => {
    const ids = parseOperatorIds(raw)
    if (ids.join(",") === stored.join(",")) {
      setDraft(null)
      return
    }
    void patchAdapterInstanceSettings(adapterId, {
      runOperatorUserIds: ids.length > 0 ? ids : undefined,
    }).then(
      () => setDraft(null),
      () => {
        // Keep the draft visible so the operator can retry; nothing was stored.
      }
    )
  }

  return (
    <Card data-testid="run-operators">
      <CardHeader className="pb-2 pt-3">
        <CardTitle className="text-sm font-medium">{t("title")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <Label htmlFor="run-operator-ids" className="text-xs">
          {t("label")}
        </Label>
        <Input
          id="run-operator-ids"
          value={draft?.adapterId === adapterId ? draft.value : storedText}
          disabled={!row}
          placeholder={t("placeholder")}
          onChange={(e) => setDraft({ adapterId, value: e.target.value })}
          onBlur={(e) => commit(e.target.value)}
          data-testid="run-operators-input"
        />
        <p className="text-xs text-muted-foreground">{t("hint")}</p>
        <p className="text-xs text-muted-foreground" data-testid="run-operators-count">
          {stored.length === 0 ? t("empty") : t("countLabel", { count: stored.length })}
        </p>
        <p className="text-xs text-muted-foreground">{t("help")}</p>
      </CardContent>
    </Card>
  )
}
