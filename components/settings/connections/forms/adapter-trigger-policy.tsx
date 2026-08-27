"use client"

/**
 * Bot-wide trigger policy card.
 *
 * `AdapterInstanceRow.trigger` was stamped once by the create dialog and never
 * writable again, so the twelve conditions the evaluator implements — keyword
 * triggers, user and channel allow/blocklists, inbound rate limits, the
 * post-reply cooldown — were unreachable for the whole life of a bot.
 *
 * Edited as a draft rather than persisted per keystroke: a trigger policy is
 * one decision made across a dozen controls, and writing each intermediate
 * state would let a half-built policy route live traffic. The parent keys this
 * on `updatedAt` so an external write re-seeds the draft, matching
 * `AdapterBehaviorDefaults`.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { getDb } from "@/lib/db/schema"
import { updateAdapterConfigSection } from "@/lib/db/adapter-instances"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"
import {
  fromTriggerPolicyDraft,
  toTriggerPolicyDraft,
  type TriggerPolicyDraft,
} from "@/lib/connectors/trigger-policy-draft"
import { defaultTriggerPolicyFor } from "@/types/connectors/policy"

import { TriggerPolicyEditor } from "./trigger-policy-editor"

export function AdapterTriggerPolicy({ adapterId }: { adapterId: string }) {
  const row = useLiveQuery(
    // `async` so both branches share one promise type — a ternary between
    // `Promise.resolve(undefined)` and a `PromiseExtended` defeats
    // `useLiveQuery`'s unwrapping and hands back the promise itself.
    async () =>
      typeof window === "undefined" ? undefined : getDb().adapterInstances.get(adapterId),
    [adapterId]
  )
  // Keyed on the STORED POLICY, not on `updatedAt`. Every write to the row
  // bumps `updatedAt` — another settings card saving, a `lastMissingScopes`
  // update, a companion sync — and remounting on those threw away an
  // in-progress edit across twelve controls with nothing to show for it. The
  // draft only owes a re-seed when the thing it drafts actually changed
  // underneath it, which includes this card's own save.
  const triggerIdentity = row ? JSON.stringify(row.trigger ?? null) : "loading"
  return (
    <TriggerPolicyDraftCard
      key={`${adapterId}:${triggerIdentity}`}
      adapterId={adapterId}
      row={row}
    />
  )
}

function TriggerPolicyDraftCard({
  adapterId,
  row,
}: {
  adapterId: string
  row?: AdapterInstanceRow
}) {
  const t = useTranslations("settings.connections.triggerPolicy")
  const [draft, setDraft] = useState<TriggerPolicyDraft>(() => toTriggerPolicyDraft(row?.trigger))

  const save = async () => {
    await updateAdapterConfigSection(
      adapterId,
      "trigger",
      { trigger: fromTriggerPolicyDraft(draft) },
      "settings.adapter.trigger"
    )
  }

  return (
    <Card data-testid="adapter-trigger-policy">
      <CardHeader className="pb-2 pt-3">
        <CardTitle className="text-sm font-medium">{t("title")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-xs text-muted-foreground">{t("adapterScopeHelp")}</p>
        <TriggerPolicyEditor idPrefix="adapter-trigger" value={draft} onChange={setDraft} />
        <div className="flex flex-wrap justify-end gap-2">
          {/* The repair path for a bot created before the default profiles
           * covered both chat scopes: its stored policy still answers in only
           * one of them, and nothing else would tell the operator to look. */}
          <Button
            variant="ghost"
            disabled={!row}
            onClick={() => row && setDraft(toTriggerPolicyDraft(defaultTriggerPolicyFor(row.type)))}
            data-testid="adapter-trigger-restore-defaults"
          >
            {t("restoreDefaults")}
          </Button>
          <Button
            variant="ghost"
            onClick={() => setDraft(toTriggerPolicyDraft(row?.trigger))}
            data-testid="adapter-trigger-cancel"
          >
            {t("cancel")}
          </Button>
          <Button onClick={() => void save()} data-testid="adapter-trigger-save">
            {t("save")}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
