"use client"

import { useState } from "react"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { updateAdapterConfigSection } from "@/lib/db/adapter-instances"
import { getDb } from "@/lib/db/schema"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"
import type { ImTargetKind } from "@/lib/connectors/composition/mode-projection"
import {
  ConversationBehaviorEditor,
  type ConversationBehaviorValue,
} from "./conversation-behavior-editor"

/**
 * The execution target this bot's conversations default to.
 *
 * Only `delegate` depends on it: background work has no carrier without a team
 * or workflow, so the editor disables that preset with a reason. Left at its
 * `"direct"` default, this card offered a permanently-disabled `delegate` even
 * on a bot with a `defaultTeamId` bound.
 */
function targetKindOf(row: AdapterInstanceRow | undefined): ImTargetKind {
  if (row?.defaultTeamId) return "team"
  if (row?.defaultWorkflowId) return "workflow"
  return "direct"
}

function fromRow(row: AdapterInstanceRow | undefined): ConversationBehaviorValue {
  return {
    mode: row?.defaultMode ?? "auto",
    autonomy: row?.defaultAutonomy,
    engagement: row?.defaultEngagement,
    authority: row?.defaultAuthority,
    inboundActivationPolicy: row?.inboundActivationPolicy,
    activeRunDispatchMode: row?.activeRunDispatchMode,
    activationTtlHours: row?.activationTtlMs ? String(row.activationTtlMs / 3_600_000) : "",
    a2ui: row?.a2uiEnabled,
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
        // The axes are what routing reads; `defaultMode` stays as the mirror.
        // Written as `undefined` when unset so clearing a pinned axis actually
        // removes it rather than leaving the previous value behind.
        defaultAutonomy: draft.autonomy,
        defaultEngagement: draft.engagement,
        defaultAuthority: draft.authority,
        inboundActivationPolicy: draft.inboundActivationPolicy,
        activeRunDispatchMode: draft.activeRunDispatchMode,
        activationTtlMs:
          Number.isFinite(hours) && hours > 0 ? Math.round(hours * 3_600_000) : undefined,
        // Tri-state: `undefined` restores "whatever this channel supports".
        a2uiEnabled: draft.a2ui,
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
        <ConversationBehaviorEditor
          scope="adapter"
          value={draft}
          onChange={setDraft}
          targetKind={targetKindOf(row)}
        />
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
