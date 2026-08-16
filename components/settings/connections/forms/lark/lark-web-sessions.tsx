"use client"

/**
 * Lark web-session ops view (ADR-0091; Dexie v126 `larkWebSessions`).
 *
 * The companion keeps web sessions STATELESS — an HMAC-signed token with a
 * TTL and nothing stored server-side — which is why "who currently holds a
 * session" is not answerable there at all. Every entry intent it forwards
 * carries a hashed session id, and the brain records the sighting; this card
 * is the read side of that ledger.
 *
 * Deliberately read-only apart from housekeeping. There is no per-session
 * "revoke" button because the companion has no revocation list to write to:
 * what actually cuts a person off is disabling their principal (the card
 * above), which every entry intent re-checks and fails closed on. Sessions
 * are stamped `revoked` by that action, not by anything here.
 */

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { listWebSessions, pruneExpiredWebSessions } from "@/lib/db/lark-entry"
import type { LarkWebSessionRow } from "@/lib/db/connector-types"

/** Live / expired / revoked, decided against a caller-supplied clock. */
export type LarkSessionState = "live" | "expired" | "revoked"

export function larkSessionState(row: LarkWebSessionRow, now: number): LarkSessionState {
  if (row.revokedAt !== undefined) return "revoked"
  return row.expiresAt > now ? "live" : "expired"
}

const STATE_BADGE_VARIANT: Record<LarkSessionState, "default" | "secondary" | "outline"> = {
  live: "default",
  expired: "outline",
  revoked: "secondary",
}

export interface LarkWebSessionsProps {
  adapterId: string
}

export function LarkWebSessions({ adapterId }: LarkWebSessionsProps) {
  const t = useTranslations("settings.connections.lark.webSessions")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [pruned, setPruned] = useState<number | null>(null)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(timer)
  }, [])

  const sessions =
    useLiveQuery<LarkWebSessionRow[]>(
      () => (typeof window === "undefined" ? Promise.resolve([]) : listWebSessions(adapterId)),
      [adapterId]
    ) ?? []

  const live = sessions.filter((row) => larkSessionState(row, now) === "live").length

  const prune = async () => {
    setBusy(true)
    setError(null)
    try {
      setPruned(await pruneExpiredWebSessions())
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card data-testid="lark-web-sessions">
      <CardHeader className="pb-2 pt-3">
        <CardTitle className="text-sm font-medium">{t("title")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">{t("description")}</p>

        {sessions.length === 0 ? (
          <p className="text-xs text-muted-foreground italic" data-testid="lark-web-sessions-empty">
            {t("empty")}
          </p>
        ) : (
          <>
            <p className="text-xs text-muted-foreground" data-testid="lark-web-sessions-summary">
              {t("summary", { live, total: sessions.length })}
            </p>
            <ul className="space-y-1.5">
              {sessions.map((row) => {
                const state = larkSessionState(row, now)
                return (
                  <li
                    key={row.id}
                    className="flex items-center justify-between gap-2 text-xs"
                    data-testid={`lark-web-session-${row.id}`}
                  >
                    <span className="flex min-w-0 flex-col">
                      <span className="font-mono break-all">{row.openIdHash}</span>
                      <span className="text-muted-foreground">
                        {t("seenAt", { at: new Date(row.lastSeenAt).toLocaleString() })}
                      </span>
                    </span>
                    <Badge variant={STATE_BADGE_VARIANT[state]} aria-label={t("stateAria")}>
                      {t(`state.${state}`)}
                    </Badge>
                  </li>
                )
              })}
            </ul>
          </>
        )}

        <div className="flex items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => void prune()}
            data-testid="lark-web-sessions-prune"
          >
            {t("prune")}
          </Button>
          {pruned !== null && (
            <span className="text-xs text-muted-foreground" role="status">
              {t("pruned", { count: pruned })}
            </span>
          )}
        </div>

        {error && (
          <p
            className="text-xs text-destructive"
            role="status"
            data-testid="lark-web-sessions-error"
          >
            {t("actionFailed", { reason: error })}
          </p>
        )}
      </CardContent>
    </Card>
  )
}
