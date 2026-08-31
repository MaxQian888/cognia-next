"use client"

/**
 * Remote document providers settings card (ADR-0134).
 *
 * Two providers, two very different setup stories, which is the whole reason
 * this card exists rather than a row in a generic list:
 *
 *   - Feishu needs NOTHING. It borrows the credentials of whichever Lark
 *     connector instances the user already bound, so the card's job is to say
 *     so and point at the adapter list. Inventing a second Feishu connection
 *     here would be a second thing to keep in sync and a second thing to
 *     revoke.
 *   - Google needs the user's own Google Cloud "Desktop app" credential,
 *     because the read scopes this feature requires cannot be obtained through
 *     the device-code flow the Drive *backup* connection uses.
 *
 * Off the desktop shell the rows stay rendered and go inert, and each says why
 * (project rule 7, UI axis). They used to be replaced wholesale by a single
 * "Desktop app only." line, which told a paired phone nothing about the
 * desktop sitting next to it that already holds both accounts. The reasoning
 * now comes from `lib/docs-providers/reach.ts` and reads out through
 * `DocsProviderNotice`.
 */

import { useCallback, useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import Link from "next/link"
import { toast } from "sonner"
import { CloudIcon, ExternalLinkIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  DocsProviderNotice,
  useDocsProviderReach,
} from "@/components/docs-providers/docs-provider-notice"
import { openUrl } from "@/lib/native/opener"
import { connectionsHref } from "@/lib/settings/deep-link"
import { listAdapterInstancesByType } from "@/lib/db/adapter-instances"
import { DocsProviderError, larkDocsProvider, googleDocsProvider } from "@/lib/docs-providers"
import {
  GOOGLE_DOCS_SCOPES,
  getGoogleDocsSettings,
  saveGoogleClientSecret,
  updateGoogleDocsSettings,
} from "@/lib/docs-providers/providers/google/config"
import {
  beginGoogleDocsAuth,
  disconnectGoogleDocs,
} from "@/lib/docs-providers/providers/google/auth"

export function DocsProvidersCard() {
  const t = useTranslations("docsProviders")

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
        <LarkDocsRow />
        <GoogleDocsRow />
      </CardContent>
    </Card>
  )
}

/**
 * Header line shared by both rows: name, its `@` namespace, and a status badge
 * pushed to the end. Identical markup in two places was how the Google row
 * grew a status badge that the Feishu row never got.
 */
function ProviderHeading({
  name,
  mentionPrefix,
  status,
  statusTone,
  testId,
}: {
  name: string
  mentionPrefix: string
  status: string | null
  statusTone: "connected" | "idle"
  testId: string
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-sm font-medium">{name}</span>
      <Badge variant="secondary" className="font-mono text-[10px]">
        @{mentionPrefix}
      </Badge>
      {status ? (
        <Badge
          variant={statusTone === "connected" ? "default" : "outline"}
          className="ml-auto text-[10px]"
          data-testid={testId}
        >
          {status}
        </Badge>
      ) : null}
    </div>
  )
}

function LarkDocsRow() {
  const t = useTranslations("docsProviders")
  const reach = useDocsProviderReach(larkDocsProvider)
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
      <ProviderHeading
        name={t("label")}
        mentionPrefix={larkDocsProvider.mentionPrefix}
        status={
          count === null
            ? null
            : count === 0
              ? t("settings.larkNoAccount")
              : t("settings.larkAccountCount", { count })
        }
        statusTone={count && count > 0 ? "connected" : "idle"}
        testId="docs-provider-lark-status"
      />
      <p className="text-muted-foreground text-xs">{t("settings.larkDescription")}</p>
      <DocsProviderNotice reach={reach} data-testid="docs-provider-lark-notice" />
      {/* The accounts this provider borrows are managed one tab over, and the
       * row used to only describe that rather than offer it. Deep-links to the
       * platform, so an empty adapter list opens the Lark "add" dialog instead
       * of a list with nothing in it. */}
      <Button
        asChild
        variant="outline"
        size="sm"
        className="mt-1"
        data-testid="docs-provider-lark-manage"
      >
        <Link href={connectionsHref({ platform: "lark" })}>
          <ExternalLinkIcon className="size-3.5" />
          {t("settings.larkManage")}
        </Link>
      </Button>
    </section>
  )
}

function GoogleDocsRow() {
  const t = useTranslations("docsProviders")
  const reach = useDocsProviderReach(googleDocsProvider)
  const [clientId, setClientId] = useState("")
  const [clientSecret, setClientSecret] = useState("")
  const [connected, setConnected] = useState(false)
  const [email, setEmail] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  // Every control below talks to the Rust loopback listener or to Google with
  // a credential only the desktop shell can complete a round trip for. Inert
  // rather than absent, with the reason above it.
  const inert = !reach.available

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
    setBusy(true)
    try {
      // Revokes at Google first, then clears local state. See
      // `disconnectGoogleDocs`. Local state is cleared either way, so the UI
      // always ends up disconnected. The toast is how the user learns that the
      // grant may still stand on Google's side and needs finishing there.
      const outcome = await disconnectGoogleDocs()
      setConnected(false)
      setEmail(undefined)
      if (outcome.revoked) {
        toast.success(t("settings.disconnectRevoked"))
      } else if (outcome.reason !== "not-connected") {
        toast.warning(t("settings.disconnectNotRevoked", { reason: outcome.reason }))
      }
    } finally {
      setBusy(false)
    }
  }, [t])

  return (
    <section className="space-y-2" data-testid="docs-provider-google">
      <ProviderHeading
        name={t("labelGoogle")}
        mentionPrefix={googleDocsProvider.mentionPrefix}
        status={
          connected
            ? t("settings.connectedAs", { email: email ?? "Google" })
            : t("settings.notConnected")
        }
        statusTone={connected ? "connected" : "idle"}
        testId="docs-provider-google-status"
      />
      <p className="text-muted-foreground text-xs">{t("settings.googleScopes")}</p>
      <ul className="text-muted-foreground list-inside list-disc font-mono text-[10px]">
        {GOOGLE_DOCS_SCOPES.map((scope) => (
          <li key={scope}>{scope.replace("https://www.googleapis.com/auth/", "")}</li>
        ))}
      </ul>
      <DocsProviderNotice reach={reach} data-testid="docs-provider-google-notice" />
      {connected ? (
        <Button
          variant="outline"
          size="sm"
          disabled={busy || inert}
          onClick={() => void disconnect()}
          data-testid="docs-provider-google-disconnect"
        >
          {busy ? t("settings.disconnecting") : t("settings.disconnect")}
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
              disabled={inert}
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
              disabled={inert}
            />
          </div>
          <p className="text-muted-foreground flex items-center gap-1 text-[11px]">
            <ExternalLinkIcon className="size-3" />
            {t("settings.googleClientHint")}
          </p>
          <Button
            size="sm"
            disabled={busy || inert || !clientId.trim()}
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
