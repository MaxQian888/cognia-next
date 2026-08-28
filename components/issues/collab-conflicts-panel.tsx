"use client"

import { useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { discardCollabConflict, rebaseCollabConflict } from "@/lib/db/mobile-outbound-queue"
import { getDb } from "@/lib/db/schema"

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
  if (!conflicts?.length) return null

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
