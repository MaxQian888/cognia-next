"use client"

/**
 * "Also revoke the share links made from this conversation" — the option
 * every conversation delete confirm offers (ADR-0222 §10).
 *
 * A share link is an independent encrypted copy, so deleting the
 * conversation leaves it working; that is the default, and the option is
 * shown only when there is a working link to revoke. It counts the links
 * made on this device (the only ones it can revoke: the owner token lives in
 * this device's mirror), live while the confirm is open.
 *
 * The revocation runs after the confirm hands the delete off and reports
 * itself in a toast: a link the share server refuses to revoke is named by
 * count, with My Shares as the place to finish.
 */

import { useCallback, useId } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import { useClientLiveQuery } from "@/hooks/data"
import {
  listLiveShareLinksForSessions,
  revokeShareLinksForSessions,
} from "@/lib/share/session-links"

export interface RevokeShareLinksOptionProps {
  sessionIds: readonly string[]
  checked: boolean
  onCheckedChange: (checked: boolean) => void
}

export function RevokeShareLinksOption({
  sessionIds,
  checked,
  onCheckedChange,
}: RevokeShareLinksOptionProps) {
  const t = useTranslations("share.deleteLinks")
  const id = useId()
  const key = sessionIds.join("\u0000")
  const count =
    useClientLiveQuery<number>(
      async () => (await listLiveShareLinksForSessions(key ? key.split("\u0000") : [])).length,
      [key],
      0
    ) ?? 0
  if (count === 0) return null
  return (
    <div className="flex items-start gap-2" data-testid="revoke-share-links-option">
      <Checkbox
        id={id}
        checked={checked}
        onCheckedChange={(next) => onCheckedChange(next === true)}
        className="mt-0.5"
      />
      <Label htmlFor={id} className="text-sm leading-snug font-normal">
        {t("option", { count })}
      </Label>
    </div>
  )
}

/** Revoke the links of conversations just handed to delete, reporting in a toast. */
export function useRevokeShareLinksAfterDelete(): (sessionIds: readonly string[]) => void {
  const t = useTranslations("share.deleteLinks")
  return useCallback(
    (sessionIds: readonly string[]) => {
      void revokeShareLinksForSessions(sessionIds)
        .then(({ revoked, failed }) => {
          if (failed > 0) toast.error(t("failed", { count: failed }))
          else if (revoked > 0) toast.success(t("revoked", { count: revoked }))
        })
        .catch(() => toast.error(t("failedAll")))
    },
    [t]
  )
}
