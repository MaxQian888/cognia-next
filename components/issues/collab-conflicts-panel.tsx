"use client"

import { useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import type { CollabFieldClash } from "@/lib/collab/client"
import { listUsers } from "@/lib/db/identity"
import { discardCollabConflict, rebaseCollabConflict } from "@/lib/db/mobile-outbound-queue"
import { getDb } from "@/lib/db/schema"

const FIELD_LABEL_KEYS = new Set(["title", "body", "description", "status", "priority", "assignee"])

/** A clash value as one line of text; objects (an assignee) as compact JSON. */
function displayValue(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  return JSON.stringify(value)
}

export function CollabConflictsPanel() {
  const t = useTranslations("issues.conflicts")
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const conflicts = useLiveQuery(
    () =>
      getDb()
        .mobileOutboundQueue.where("status")
        .equals("conflicted")
        .filter((row) => row.protocol === "collab-v1")
        .toArray(),
    []
  )
  const authorIds = [
    ...new Set(
      (conflicts ?? []).flatMap((row) =>
        Object.values(row.conflictFields ?? {}).flatMap((clash) =>
          clash.changedBy ? [clash.changedBy] : []
        )
      )
    ),
  ]
  const authors = useLiveQuery(
    async () => new Map((await listUsers(authorIds)).map((user) => [user.id, user.displayName])),
    [authorIds.join(",")]
  )
  if (!conflicts?.length) return null

  const fieldLabel = (field: string) => {
    if (field.startsWith("steps.")) return t("field.step", { id: field.slice("steps.".length) })
    return FIELD_LABEL_KEYS.has(field) ? t(`field.${field}`) : field
  }

  const renderFields = (rowId: string, fields: Record<string, CollabFieldClash>) => (
    <div className="space-y-2" data-testid={`conflict-fields-${rowId}`}>
      <p className="text-xs text-muted-foreground">{t("fieldsHeading")}</p>
      {Object.entries(fields).map(([field, clash]) => {
        const name = clash.changedBy ? authors?.get(clash.changedBy) : undefined
        return (
          <div
            key={field}
            className="rounded bg-muted p-2 text-[11px]"
            data-testid={`conflict-field-${rowId}-${field}`}
          >
            <p className="font-medium">{fieldLabel(field)}</p>
            <p>
              <span className="text-muted-foreground">{t("fieldYours")}: </span>
              {displayValue(clash.yours) ?? t("emptyValue")}
            </p>
            <p>
              <span className="text-muted-foreground">{t("fieldTheirs")}: </span>
              {displayValue(clash.theirs) ?? t("emptyValue")}
            </p>
            <p className="text-muted-foreground">
              {name
                ? t("changedBy", { name, revision: clash.changedAt })
                : t("changedByUnknown", { revision: clash.changedAt })}
            </p>
          </div>
        )
      })}
    </div>
  )

  const act = async (id: string, action: () => Promise<unknown>) => {
    setBusyId(id)
    setError(null)
    try {
      await action()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusyId(null)
    }
  }

  return (
    <Card className="border-amber-500/50" data-testid="collab-conflicts-panel">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">{t("title", { count: conflicts.length })}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">{t("description")}</p>
        {conflicts.map((row) => (
          <div
            key={row.id}
            className="space-y-2 rounded-md border p-3"
            data-testid={`conflict-${row.id}`}
          >
            <p className="text-xs font-medium">{row.label ?? row.command}</p>
            {row.conflictFields ? (
              renderFields(row.id, row.conflictFields)
            ) : (
              <div className="grid gap-2 md:grid-cols-2">
                <div>
                  <p className="mb-1 text-xs text-muted-foreground">{t("serverValue")}</p>
                  <pre className="max-h-40 overflow-auto rounded bg-muted p-2 text-[11px]">
                    {JSON.stringify(row.conflictAuthoritative, null, 2)}
                  </pre>
                </div>
                <div>
                  <p className="mb-1 text-xs text-muted-foreground">{t("pendingPatch")}</p>
                  <pre className="max-h-40 overflow-auto rounded bg-muted p-2 text-[11px]">
                    {JSON.stringify(row.payload, null, 2)}
                  </pre>
                </div>
              </div>
            )}
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={busyId === row.id}
                onClick={() => void act(row.id, () => discardCollabConflict(row.id))}
              >
                {t("discard")}
              </Button>
              <Button
                size="sm"
                disabled={busyId === row.id}
                onClick={() => void act(row.id, () => rebaseCollabConflict(row.id))}
              >
                {t("resubmit")}
              </Button>
            </div>
          </div>
        ))}
        {error ? (
          <p role="status" className="text-xs text-destructive">
            {t("failed", { reason: error })}
          </p>
        ) : null}
      </CardContent>
    </Card>
  )
}
