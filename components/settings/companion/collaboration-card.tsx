"use client"

/**
 * Where the collaboration plane's address is set — ADR-0149 §6.
 *
 * # Why this card is the whole unblock
 *
 * The plane's client, mirror, board source, membership pull and share-server
 * tenancy all shipped in earlier batches, and none of them ran: nothing knew
 * where the server was. This is the only surface that answers that, so it is
 * also the switch that turns the rest on.
 *
 * # Only the URL
 *
 * There is no credential field, deliberately. The identity is the Logto
 * session the card above this one establishes, and the org comes from the
 * sign-in binding — asking somebody to type their own org id is asking them to
 * get it wrong, and it would be a second place for that fact to be stale.
 */

import { useCallback, useEffect, useState } from "react"
import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { getActiveAccountId } from "@/lib/accounts/active-account-id"
import {
  forgetCollabConnection,
  loadCollabConnection,
  saveCollabConnection,
} from "@/lib/collab/connection"
import { refreshCollabPlane, type RefreshCollabPlaneResult } from "@/lib/collab/refresh"

export function CollaborationCard() {
  const t = useTranslations("mobile.companion.collaboration")
  const [baseUrl, setBaseUrl] = useState("")
  const [saved, setSaved] = useState(false)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<RefreshCollabPlaneResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    // Deferred rather than read in a lazy `useState` initializer: this is a
    // statically exported page, so an initializer that read `localStorage`
    // would render one value at build time and another on the client. The
    // microtask also keeps the write out of the effect body, which is what
    // `react-hooks/set-state-in-effect` is guarding — same shape the Logto
    // card above uses.
    queueMicrotask(() => {
      const stored = loadCollabConnection(getActiveAccountId())
      setBaseUrl(stored?.baseUrl ?? "")
      setSaved(Boolean(stored))
    })
  }, [])

  const save = useCallback(() => {
    setError(null)
    const trimmed = baseUrl.trim()
    if (!trimmed) {
      forgetCollabConnection(getActiveAccountId())
      setSaved(false)
      setStatus(null)
      return
    }
    try {
      const stored = saveCollabConnection(getActiveAccountId(), { baseUrl: trimmed })
      setBaseUrl(stored.baseUrl)
      setSaved(true)
      setStatus(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [baseUrl])

  /**
   * Pull once, now, and report what came back.
   *
   * The same call the issue tracker makes at boot, so a green result here
   * means the board will fill — rather than a bespoke health check that can
   * pass while the real path fails.
   */
  const test = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      setStatus(await refreshCollabPlane())
    } catch (cause) {
      setStatus(null)
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }, [])

  return (
    <Card data-testid="collaboration-card">
      <CardHeader className="pb-2 pt-3">
        <CardTitle className="text-sm font-medium">{t("title")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">{t("help")}</p>

        <div className="space-y-1.5">
          <Label className="text-xs" htmlFor="collab-base-url">
            {t("urlLabel")}
          </Label>
          <Input
            id="collab-base-url"
            value={baseUrl}
            placeholder={t("urlPlaceholder")}
            onChange={(event) => setBaseUrl(event.target.value)}
            data-testid="collaboration-url"
          />
        </div>

        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" onClick={save} data-testid="collaboration-save">
            {baseUrl.trim() ? t("save") : t("clear")}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={!saved || busy}
            onClick={() => void test()}
            data-testid="collaboration-test"
          >
            {t("test")}
          </Button>
        </div>

        {status?.status === "refreshed" ? (
          <p
            className="text-xs text-emerald-600 dark:text-emerald-400"
            data-testid="collaboration-ok"
          >
            {t("refreshed", { issues: status.issues, workspaces: status.workspaces })}
          </p>
        ) : null}
        {status?.status === "skipped" ? (
          // Not an error: no server, nobody signed in, or a personal account
          // with no org are all ordinary states, and calling them failures
          // sends people looking for a problem that is not there.
          <p className="text-xs text-muted-foreground" data-testid="collaboration-skipped">
            {t(`skipped.${status.reason}`)}
          </p>
        ) : null}
        {error ? (
          <p className="text-xs text-destructive" role="status" data-testid="collaboration-error">
            {t("failed", { reason: error })}
          </p>
        ) : null}
      </CardContent>
    </Card>
  )
}
