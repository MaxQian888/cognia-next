"use client"

/**
 * Bot-wide response-SLA + escalation defaults card (IM delegation slice 1B).
 * Mirrors `adapter-behavior-defaults.tsx`: live-query the adapter row,
 * remount the draft on `updatedAt` (no set-state-in-effect), and persist one
 * `updateAdapterConfigSection(id, "delivery", …, "settings.adapter.sla-escalation")`
 * so the change lands with its `adapter.config_changed` audit breadcrumb.
 *
 * Writes `defaultSlaResponseMinutes` (undefined = no default SLA) and
 * `defaultEscalation` (undefined = no escalation; an empty chain is
 * normalised to undefined at this scope). Conversations inherit both unless
 * their override row sets its own `slaResponseMinutes` / `escalation`.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { updateAdapterConfigSection } from "@/lib/db/adapter-instances"
import { getDb } from "@/lib/db/schema"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"
import { validateEscalationPolicy } from "@/lib/connectors/escalation/policy"
import type { EscalationPolicy } from "@/types/connectors/escalation"
import {
  EscalationPolicyEditor,
  type EscalationCharacterOption,
} from "@/components/inbox/overrides/escalation-policy-editor"

interface SlaEscalationDraft {
  slaMinutes: string
  escalation: EscalationPolicy | undefined
}

function fromRow(row: AdapterInstanceRow | undefined): SlaEscalationDraft {
  return {
    slaMinutes: row?.defaultSlaResponseMinutes != null ? String(row.defaultSlaResponseMinutes) : "",
    escalation: row?.defaultEscalation,
  }
}

/** Parse the SLA-minutes text buffer into a positive integer, or undefined. */
export function parseSlaMinutes(buffer: string): number | undefined {
  const trimmed = buffer.trim()
  if (!trimmed) return undefined
  const n = Number(trimmed)
  return Number.isFinite(n) && n > 0 ? Math.round(n) : undefined
}

export function SlaEscalationDefaults({ adapterId }: { adapterId: string }) {
  const row = useLiveQuery(
    async (): Promise<AdapterInstanceRow | undefined> =>
      typeof window === "undefined" ? undefined : getDb().adapterInstances.get(adapterId),
    [adapterId]
  )
  const characters = useLiveQuery(
    async (): Promise<EscalationCharacterOption[]> => {
      if (typeof window === "undefined") return []
      const rows = await getDb().characters.toArray()
      return rows.map((c) => ({ id: c.id, name: c.name }))
    },
    [],
    [] as EscalationCharacterOption[]
  )
  return (
    <SlaEscalationDraftCard
      key={`${adapterId}:${row?.updatedAt ?? "loading"}`}
      adapterId={adapterId}
      row={row}
      characters={characters ?? []}
    />
  )
}

function SlaEscalationDraftCard({
  adapterId,
  row,
  characters,
}: {
  adapterId: string
  row?: AdapterInstanceRow
  characters: readonly EscalationCharacterOption[]
}) {
  const t = useTranslations("settings.connections.slaEscalation")
  const [draft, setDraft] = useState<SlaEscalationDraft>(() => fromRow(row))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const policyValid = draft.escalation ? validateEscalationPolicy(draft.escalation).ok : true

  const save = async () => {
    if (!policyValid) return
    setSaving(true)
    setError(null)
    try {
      const escalation =
        draft.escalation && draft.escalation.steps.length > 0 ? draft.escalation : undefined
      await updateAdapterConfigSection(
        adapterId,
        "delivery",
        {
          defaultSlaResponseMinutes: parseSlaMinutes(draft.slaMinutes),
          defaultEscalation: escalation,
        },
        "settings.adapter.sla-escalation"
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card data-testid="sla-escalation-defaults">
      <CardHeader className="pb-2 pt-3">
        <CardTitle className="text-sm font-medium">{t("title")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-xs text-muted-foreground">{t("description")}</p>
        <div className="space-y-1.5">
          <Label htmlFor="adapter-sla-minutes">{t("slaMinutes")}</Label>
          <Input
            id="adapter-sla-minutes"
            type="number"
            min={1}
            inputMode="numeric"
            value={draft.slaMinutes}
            placeholder={t("slaMinutesPlaceholder")}
            disabled={saving}
            onChange={(e) => setDraft({ ...draft, slaMinutes: e.target.value })}
            data-testid="adapter-sla-minutes"
          />
          <p className="text-xs text-muted-foreground">{t("slaMinutesHint")}</p>
        </div>
        <div className="space-y-1.5">
          <Label>{t("escalationTitle")}</Label>
          <p className="text-xs text-muted-foreground">{t("escalationHint")}</p>
          <EscalationPolicyEditor
            scope="adapter"
            platform={row?.type}
            value={draft.escalation ?? { steps: [] }}
            onChange={(next) => setDraft({ ...draft, escalation: next })}
            characters={characters}
            disabled={saving}
            idPrefix="adapter-escalation"
          />
        </div>
        {error && (
          <p className="text-xs text-destructive" role="alert" data-testid="sla-escalation-error">
            {t("saveFailed", { error })}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" disabled={saving} onClick={() => setDraft(fromRow(row))}>
            {t("cancel")}
          </Button>
          <Button
            disabled={saving || !policyValid}
            onClick={() => void save()}
            data-testid="sla-escalation-save"
          >
            {t("save")}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
