"use client"

/**
 * The trusted-publisher ledger, listed and revocable.
 *
 * `lib/db/trusted-publishers.ts` shipped with `listTrustedPublishers` and
 * `revokePublisher` and one writer: the WASM plugin HTTP installer. Nothing in
 * the app ever READ the table back, so a key accepted once during a plugin
 * install silently auto-trusted every later package from that author, with no
 * surface anywhere that could say which keys were on the list or take one off.
 *
 * It lives in the Studio's Packages tab because that tab already owns package
 * trust, and template packages are now the second writer (the import dialog's
 * "Trust this publisher"). The rows are shared with plugins on purpose: one
 * author, one key, one decision.
 */

import { useCallback, useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { BadgeCheckIcon, Trash2Icon } from "lucide-react"
import { toast } from "sonner"

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
import { Button } from "@/components/ui/button"
import {
  listTrustedPublishers,
  revokePublisher,
  type TrustedPublisherRow,
} from "@/lib/db/trusted-publishers"

export interface TemplateTrustedPublishersCardProps {
  /** Bumped by the caller after a new key is trusted, to force a re-read. */
  refreshToken?: number
}

export function TemplateTrustedPublishersCard({
  refreshToken = 0,
}: TemplateTrustedPublishersCardProps) {
  const t = useTranslations("templateStudio.trustedPublishers")
  const [rows, setRows] = useState<TrustedPublisherRow[]>([])
  const [epoch, setEpoch] = useState(0)
  const [pendingRevoke, setPendingRevoke] = useState<TrustedPublisherRow | null>(null)

  useEffect(() => {
    let active = true
    void listTrustedPublishers()
      .then((next) => {
        if (active) setRows(next)
      })
      .catch(() => {
        if (active) setRows([])
      })
    return () => {
      active = false
    }
  }, [epoch, refreshToken])

  const revoke = useCallback(
    async (row: TrustedPublisherRow) => {
      try {
        await revokePublisher(row.publicKey)
        toast.success(t("revoked"))
        setEpoch((value) => value + 1)
      } catch (error) {
        toast.error(error instanceof Error ? error.message : String(error))
      } finally {
        setPendingRevoke(null)
      }
    },
    [t]
  )

  return (
    <div className="space-y-2 rounded-panel border p-3" data-testid="template-trusted-publishers">
      <p className="flex items-center gap-2 text-sm font-medium">
        <BadgeCheckIcon className="size-4" />
        {t("title")}
      </p>
      <p className="text-xs text-muted-foreground">{t("hint")}</p>
      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t("empty")}</p>
      ) : (
        <ul className="space-y-2">
          {rows.map((row) => (
            <li
              key={row.publicKey}
              className="flex flex-wrap items-center gap-2"
              data-testid="template-trusted-publisher-row"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm">{row.authorName || t("unnamed")}</p>
                <p className="break-all font-mono text-xs text-muted-foreground">
                  {row.fingerprint}
                </p>
              </div>
              <Button
                size="sm"
                variant="ghost"
                className="text-destructive"
                onClick={() => setPendingRevoke(row)}
                data-testid="template-trusted-publisher-revoke"
              >
                <Trash2Icon className="size-3.5" />
                {t("revoke")}
              </Button>
            </li>
          ))}
        </ul>
      )}

      <AlertDialog
        open={pendingRevoke !== null}
        onOpenChange={(open) => !open && setPendingRevoke(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("revokeTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("revokeDescription", { name: pendingRevoke?.authorName || t("unnamed") })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (pendingRevoke) void revoke(pendingRevoke)
              }}
            >
              {t("revoke")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
