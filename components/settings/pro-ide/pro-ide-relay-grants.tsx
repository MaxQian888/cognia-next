"use client"

/**
 * The paired devices this desktop's owner let into a project's VS Code.
 *
 * Each approval (given in `CodeServerRelayGrantPrompt`) lets one device open
 * one project's workbench through the companion relay, with that workbench's
 * terminals. This is where the owner sees them all and takes one back; the
 * device's open session closes within seconds of a revoke.
 */

import { useCallback, useEffect, useState } from "react"
import { useLocale, useTranslations } from "next-intl"
import { SquareTerminalIcon, XIcon } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import {
  CODESERVER_EVENTS,
  codeServerClient,
  type CodeServerRelayGrant,
} from "@/lib/codeserver/client"
import { getPairedDevice } from "@/lib/db/paired-devices"
import { onTauriEvent } from "@/lib/tauri/events"
import { safeUnlisten } from "@/lib/tauri/safe-unlisten"

interface Row extends CodeServerRelayGrant {
  label: string | null
}

const keyOf = (grant: CodeServerRelayGrant) => `${grant.deviceId}\u0000${grant.root}`

export function ProIdeRelayGrants() {
  const t = useTranslations("settings.proIde")
  const locale = useLocale()
  const [rows, setRows] = useState<Row[] | null>(null)
  const [revoking, setRevoking] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const grants = await codeServerClient.relayGrants()
      const labelled = await Promise.all(
        grants.map(async (grant) => {
          try {
            return { ...grant, label: (await getPairedDevice(grant.deviceId))?.label ?? null }
          } catch {
            return { ...grant, label: null }
          }
        })
      )
      setRows(labelled)
    } catch {
      setRows([])
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    let unlisten: (() => void) | null = null
    // Fetch-on-mount; an ask arriving while this is open will usually be
    // answered moments later, so re-read then too.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh()
    void onTauriEvent(CODESERVER_EVENTS.relayGrantRequested, () => {
      if (!cancelled) void refresh()
    }).then((fn) => {
      if (cancelled) fn()
      else unlisten = fn
    })
    return () => {
      cancelled = true
      safeUnlisten(unlisten)
    }
  }, [refresh])

  const revoke = async (row: Row) => {
    setRevoking(keyOf(row))
    try {
      await codeServerClient.relayGrantRevoke(row.deviceId, row.root)
      toast.success(t("relayGrantsRevoked"))
    } catch (cause) {
      toast.error(t("relayGrantsRevokeFailed", { error: String(cause) }))
    } finally {
      setRevoking(null)
      await refresh()
    }
  }

  const date = new Intl.DateTimeFormat(locale, { dateStyle: "medium" })

  return (
    <Card data-testid="pro-ide-relay-grants">
      <CardHeader>
        <CardTitle>{t("relayGrantsTitle")}</CardTitle>
        <CardDescription>{t("relayGrantsDescription")}</CardDescription>
      </CardHeader>
      <CardContent className="text-sm">
        {rows === null ? null : rows.length === 0 ? (
          <p className="text-muted-foreground" data-testid="pro-ide-relay-grants-empty">
            {t("relayGrantsEmpty")}
          </p>
        ) : (
          <ul className="divide-y">
            {rows.map((row) => (
              <li
                key={keyOf(row)}
                className="flex items-center gap-3 py-2"
                data-testid="pro-ide-relay-grant"
              >
                <SquareTerminalIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{row.label ?? row.deviceId}</p>
                  <p className="truncate font-mono text-xs text-muted-foreground" title={row.root}>
                    {row.root}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {t("relayGrantsGrantedAt", { date: date.format(row.grantedAtMs) })}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  className="text-destructive hover:text-destructive"
                  disabled={revoking !== null}
                  onClick={() => void revoke(row)}
                  aria-label={t("relayGrantsRevokeLabel", { device: row.label ?? row.deviceId })}
                >
                  <XIcon className="size-3.5" />
                  {t("relayGrantsRevoke")}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}
