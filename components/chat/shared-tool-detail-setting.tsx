"use client"

/**
 * How much of a tool call a shared conversation's members see (ADR-0241 D18).
 *
 * Off (the default, `summary`): which tools ran, the workspace files they
 * touched and how much changed. On (`full`): also the commands, edits,
 * searches and to-dos, redacted. Only an owner or a maintainer changes it,
 * and turning it on asks first: redaction is pattern-based and can miss an
 * internal hostname or a custom secret. A change applies from the run's next
 * publication; it never rewrites what members already saw.
 */

import { useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import type { SharedSession, SharedToolDetail } from "@cognia/agent-config-types"

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import type { CollabClient } from "@/lib/collab/client"

export interface SharedToolDetailSettingProps {
  client: Pick<CollabClient, "updateSharedSession">
  orgId: string
  session: SharedSession
  /** The viewer may change session settings (`session.manageSettings`). */
  canChange: boolean
  onChanged: (session: SharedSession) => void
}

export function SharedToolDetailSetting({
  client,
  orgId,
  session,
  canChange,
  onChanged,
}: SharedToolDetailSettingProps) {
  const t = useTranslations("chatCollaboration")
  const [saving, setSaving] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const full = session.toolDetail === "full"

  const save = async (toolDetail: SharedToolDetail) => {
    setSaving(true)
    try {
      onChanged(
        await client.updateSharedSession(orgId, session.id, {
          toolDetail,
          operationId: `tool-detail:${session.id}:${session.revision}:${toolDetail}`,
          baseRevision: session.revision,
        })
      )
    } catch {
      toast.error(t("toolDetailFailed"))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex items-start gap-3 rounded-lg border p-3" data-testid="shared-tool-detail">
      <div className="min-w-0 flex-1 space-y-1">
        <Label htmlFor="shared-tool-detail-switch">{t("toolDetailLabel")}</Label>
        <p className="text-muted-foreground text-xs">{t("toolDetailDescription")}</p>
        {canChange ? null : (
          <p className="text-muted-foreground text-xs">{t("toolDetailReadOnly")}</p>
        )}
      </div>
      <Switch
        id="shared-tool-detail-switch"
        checked={full}
        disabled={!canChange || saving}
        onCheckedChange={(checked) => {
          if (checked) setConfirming(true)
          else void save("summary")
        }}
      />
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("toolDetailConfirmTitle")}</AlertDialogTitle>
            <AlertDialogDescription>{t("toolDetailConfirmWarning")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("toolDetailCancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={() => void save("full")}>
              {t("toolDetailConfirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
