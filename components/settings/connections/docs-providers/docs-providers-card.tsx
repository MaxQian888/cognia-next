"use client"

/**
 * Remote document providers settings card (ADR-0134).
 *
 * Two providers, two very different setup stories, which is the whole reason
 * this card exists rather than a row in a generic list:
 *
 *   - Feishu needs NOTHING. It borrows the credentials of whichever Lark
 *     connector instances the user already bound, so the card's job is to say
 *     so and point at the adapter list — inventing a second Feishu connection
 *     here would be a second thing to keep in sync and a second thing to revoke.
 *   - Google needs the user's own Google Cloud "Desktop app" credential,
 *     because the read scopes this feature requires cannot be obtained through
 *     the device-code flow the Drive *backup* connection uses.
 *
 * Off the desktop shell both are inert and say why (project rule 7, UI axis).
 */

import { useCallback, useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { CloudIcon, ExternalLinkIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { openUrl } from "@/lib/native/opener"
import { listAdapterInstancesByType } from "@/lib/db/adapter-instances"
import {
  DocsProviderError,
  isDocsProviderHostSupported,
  larkDocsProvider,
  googleDocsProvider,
} from "@/lib/docs-providers"
import {
  GOOGLE_DOCS_SCOPES,
  getGoogleDocsSettings,
  saveGoogleClientSecret,
  updateGoogleDocsSettings,
  clearGoogleConnection,
} from "@/lib/docs-providers/providers/google/config"
import { beginGoogleDocsAuth } from "@/lib/docs-providers/providers/google/auth"

export function DocsProvidersCard() {
  const t = useTranslations("docsProviders")
  const hostSupported = isDocsProviderHostSupported(googleDocsProvider)

  return (
    <Card data-testid="docs-providers-card">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-sm font-medium">
          <CloudIcon className="size-4" />
          {t("settings.title")}
        </CardTitle>
        <p className="text-muted-foreground text-xs">{t("settings.description")}</p>
      </CardHeader>
      <CardContent className="space-y-6">
        {!hostSupported ? (
          <p className="text-muted-foreground text-xs" data-testid="docs-providers-desktop-only">
            {t("settings.desktopOnly")}
          </p>
        ) : (
          <>
            <LarkDocsRow />
            <GoogleDocsRow />
          </>
        )}
      </CardContent>
    </Card>
  )
}

function LarkDocsRow() {
  const t = useTranslations("docsProviders")
  const [count, setCount] = useState<number | null>(null)

  useEffect(() => {
    let cancelled = false
    void listAdapterInstancesByType("lark")
      .then((rows) => {
        if (!cancelled) setCount(rows.filter((row) => row.enabled).length)
      })
      .catch(() => {
        if (!cancelled) setCount(0)
      })
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <section className="space-y-1.5" data-testid="docs-provider-lark">
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium">{t("label")}</span>
        <Badge variant="secondary" className="font-mono text-[10px]">
          @{larkDocsProvider.mentionPrefix}
        </Badge>
      </div>
      <p className="text-muted-foreground text-xs">{t("settings.larkDescription")}</p>
      <p className="text-xs" data-testid="docs-provider-lark-status">
        {count === null
          ? null
          : count === 0
            ? t("settings.larkNoAccount")
            : t("settings.larkAccountCount", { count })}
      </p>
    </section>
  )
}

function GoogleDocsRow() {
  const t = useTranslations("docsProviders")
  const [clientId, setClientId] = useState("")
  const [clientSecret, setClientSecret] = useState("")
  const [connected, setConnected] = useState(false)
  const [email, setEmail] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    void getGoogleDocsSettings().then((settings) => {
      if (cancelled) return
      setClientId(settings.clientId ?? "")
      setConnected(Boolean(settings.connected))
      setEmail(settings.accountEmail)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const connect = useCallback(async () => {
    setBusy(true)
    try {
      await updateGoogleDocsSettings({ clientId: clientId.trim() })
      if (clientSecret.trim()) await saveGoogleClientSecret(clientSecret.trim())
      const { authorizeUrl } = await beginGoogleDocsAuth()
      // The consent page must open in the user's real browser: Google blocks
      // sign-in from embedded webviews.
      await openUrl(authorizeUrl)
      // The exchange completes in `ConnectorDeepLinkRouter` when the loopback
      // route bounces back, so this row only reports that the hand-off started.
      setClientSecret("")
    } catch (err) {
      const reason =
        err instanceof DocsProviderError
          ? t(`errors.${err.code}`, err.params ?? {})
          : err instanceof Error
            ? err.message
            : String(err)
      toast.error(t("settings.connectFailed", { reason }))
    } finally {
      setBusy(false)
    }
  }, [clientId, clientSecret, t])

  const disconnect = useCallback(async () => {
    await clearGoogleConnection()
    setConnected(false)
    setEmail(undefined)
  }, [])

  return (
    <section className="space-y-2" data-testid="docs-provider-google">
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium">{t("labelGoogle")}</span>
        <Badge variant="secondary" className="font-mono text-[10px]">
          @{googleDocsProvider.mentionPrefix}
        </Badge>
        <Badge
          variant={connected ? "default" : "outline"}
          className="ml-auto text-[10px]"
          data-testid="docs-provider-google-status"
        >
          {connected
            ? t("settings.connectedAs", { email: email ?? "Google" })
            : t("settings.notConnected")}
        </Badge>
      </div>
      <p className="text-muted-foreground text-xs">{t("settings.googleScopes")}</p>
      <ul className="text-muted-foreground list-inside list-disc font-mono text-[10px]">
        {GOOGLE_DOCS_SCOPES.map((scope) => (
          <li key={scope}>{scope.replace("https://www.googleapis.com/auth/", "")}</li>
        ))}
      </ul>
      {connected ? (
        <Button variant="outline" size="sm" onClick={() => void disconnect()}>
          {t("settings.disconnect")}
        </Button>
      ) : (
        <div className="space-y-2">
          <div className="space-y-1">
            <Label htmlFor="docs-google-client-id" className="text-xs">
              {t("settings.googleClientId")}
            </Label>
            <Input
              id="docs-google-client-id"
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="docs-google-client-secret" className="text-xs">
              {t("settings.googleClientSecret")}
            </Label>
            <Input
              id="docs-google-client-secret"
              type="password"
              value={clientSecret}
              onChange={(e) => setClientSecret(e.target.value)}
              autoComplete="off"
            />
          </div>
          <p className="text-muted-foreground flex items-center gap-1 text-[11px]">
            <ExternalLinkIcon className="size-3" />
            {t("settings.googleClientHint")}
          </p>
          <Button
            size="sm"
            disabled={busy || !clientId.trim()}
            onClick={() => void connect()}
            data-testid="docs-provider-google-connect"
          >
            {busy ? t("settings.connecting") : t("settings.connect")}
          </Button>
        </div>
      )}
    </section>
  )
}
