"use client"

import { useState } from "react"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { updateAdapterConfigSection } from "@/lib/db/adapter-instances"
import { getDb } from "@/lib/db/schema"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"
import {
  ConversationBehaviorEditor,
  type ConversationBehaviorValue,
} from "./conversation-behavior-editor"

function fromRow(row: AdapterInstanceRow | undefined): ConversationBehaviorValue {
  return {
    mode: row?.defaultMode ?? "auto",
    inboundActivationPolicy: row?.inboundActivationPolicy,
    activeRunDispatchMode: row?.activeRunDispatchMode,
    activationTtlHours: row?.activationTtlMs ? String(row.activationTtlMs / 3_600_000) : "",
  }
}

export function AdapterBehaviorDefaults({ adapterId }: { adapterId: string }) {
  const row = useLiveQuery(
    // `async` so both branches share one `Promise<AdapterInstanceRow | undefined>`.
    // The ternary's mixed `Promise.resolve(undefined)` / `PromiseExtended<...>`
    // union defeated `useLiveQuery`'s unwrapping, so `row` came back as the
    // promise itself.
    async () =>
      typeof window === "undefined" ? undefined : getDb().adapterInstances.get(adapterId),
    [adapterId]
  )
  return (
    <AdapterBehaviorDraft
      key={`${adapterId}:${row?.updatedAt ?? "loading"}`}
      adapterId={adapterId}
      row={row}
    />
  )
}

function AdapterBehaviorDraft({ adapterId, row }: { adapterId: string; row?: AdapterInstanceRow }) {
  const t = useTranslations("settings.connections.behaviorEditor")
  const [draft, setDraft] = useState<ConversationBehaviorValue>(() => fromRow(row))

  const save = async () => {
    const hours = Number(draft.activationTtlHours)
    await updateAdapterConfigSection(
      adapterId,
      "behavior",
      {
        defaultMode: draft.mode ?? "auto",
        inboundActivationPolicy: draft.inboundActivationPolicy,
        activeRunDispatchMode: draft.activeRunDispatchMode,
        activationTtlMs:
          Number.isFinite(hours) && hours > 0 ? Math.round(hours * 3_600_000) : undefined,
      },
      "settings.adapter.behavior"
    )
  }

  return (
    <Card data-testid="adapter-behavior-defaults">
      <CardHeader className="pb-2 pt-3">
        <CardTitle className="text-sm font-medium">{t("title")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <ConversationBehaviorEditor scope="adapter" value={draft} onChange={setDraft} />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setDraft(fromRow(row))}>
            {t("cancel")}
          </Button>
          <Button onClick={() => void save()}>{t("save")}</Button>
        </div>
      </CardContent>
    </Card>
  )
}
