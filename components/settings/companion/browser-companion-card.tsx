"use client"

import { useCallback, useEffect, useState } from "react"
import { CopyIcon, MonitorSmartphoneIcon, PuzzleIcon } from "lucide-react"
import { useTranslations } from "next-intl"

import { encodeBrowserEnrollmentPayload } from "@cognia/companion-client"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { isTauri, transport } from "@/lib/tauri"

/** Mirrors Rust `companion_api::commands::BrowserEnrollmentIssue`. */
export interface BrowserEnrollmentIssue {
  enrollment: string
  expiresAtMs: number
  baseUrl: string
  tenantId: string
}

/** The subset of `BrowserAccessSummary` this card needs. */
interface BrowserAccessListenerState {
  boundPort: number | null
}

export interface BrowserCompanionCardProps {
  /** Test seam — defaults to the real `companion_browser_access_get`. */
  loadListener?: () => Promise<BrowserAccessListenerState>
  /** Test seam — defaults to the real `companion_create_browser_enrollment`. */
  createEnrollment?: () => Promise<BrowserEnrollmentIssue>
  /** Test seam — defaults to the platform clipboard. */
  copy?: (text: string) => Promise<void>
  /** Test seam — injectable clock. */
  now?: () => number
}

const defaultLoadListener = () =>
  transport.call<BrowserAccessListenerState>("companion_browser_access_get", {})

const defaultCreateEnrollment = () =>
  transport.call<BrowserEnrollmentIssue>("companion_create_browser_enrollment", {})

const defaultCopy = (text: string) => navigator.clipboard.writeText(text)

/**
 * Pair the Cognia browser extension with this Host.
 *
 * A separate card from Browser Access even though it depends on it, because
 * the two answer different questions. Browser Access is a transport switch —
 * which origins may reach this computer at all. This is a pairing act, and
 * pairing has a lifetime, a single use, and a code the user has to carry
 * somewhere. Folding them together would put a one-shot credential inside a
 * settings toggle.
 *
 * The dependency is stated rather than hidden: with no listener bound, a code
 * would name an address nothing is answering on, so the card refuses to mint
 * one and says which switch to turn on. That is the same reason the Rust
 * command refuses — a code that cannot connect sends the user to the extension
 * to discover a failure whose cause lives here.
 */
export function BrowserCompanionCard({
  loadListener = defaultLoadListener,
  createEnrollment = defaultCreateEnrollment,
  copy = defaultCopy,
  now = () => Date.now(),
}: BrowserCompanionCardProps = {}) {
  const t = useTranslations("mobile.companion.browserCompanion")
  const [listening, setListening] = useState<boolean | null>(null)
  const [issue, setIssue] = useState<BrowserEnrollmentIssue | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!isTauri()) return
    let cancelled = false
    void loadListener()
      .then((summary) => {
        if (!cancelled) setListening(summary.boundPort !== null)
      })
      .catch(() => {
        if (!cancelled) setListening(false)
      })
    return () => {
      cancelled = true
    }
  }, [loadListener])

  const generate = useCallback(async () => {
    setBusy(true)
    setCopied(false)
    try {
      setError(null)
      setIssue(await createEnrollment())
    } catch (caught) {
      // The Rust side refuses when the listener is not bound and says why.
      // Surfacing its message beats a generic failure, because the remedy is
      // a different control on this same page.
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
    }
  }, [createEnrollment])

  if (!isTauri()) return null

  const code = issue
    ? encodeBrowserEnrollmentPayload({
        baseUrl: issue.baseUrl,
        tenantId: issue.tenantId,
        enrollment: issue.enrollment,
        expiresAt: issue.expiresAtMs,
      })
    : null
  const msRemaining = issue ? issue.expiresAtMs - now() : 0
  const expired = issue !== null && msRemaining <= 0
  const minutesLeft = Math.max(1, Math.ceil(msRemaining / 60_000))

  const onCopy = async () => {
    if (!code) return
    try {
      await copy(code)
      setCopied(true)
      setError(null)
    } catch {
      setCopied(false)
      setError(t("copyFailed"))
    }
  }

  return (
    <Card data-testid="browser-companion-card">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-sm">
          <PuzzleIcon className="size-4" aria-hidden="true" />
          {t("title")}
        </CardTitle>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {/* Rendered as a disabled control with the reason beside it, never
            hidden: a missing button reads as "this build does not have the
            feature", which is a different answer from "one switch away". */}
        {listening === false ? (
          <Alert data-testid="browser-companion-needs-listener">
            <AlertDescription>{t("requiresListener")}</AlertDescription>
          </Alert>
        ) : null}

        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant={issue ? "outline" : "default"}
            disabled={busy || listening === false}
            onClick={() => void generate()}
          >
            {busy ? t("generating") : issue ? t("regenerate") : t("generate")}
          </Button>
          {issue && !expired ? (
            <span className="text-xs text-muted-foreground" data-testid="browser-companion-expiry">
              {t("expiresIn", { minutes: minutesLeft })}
            </span>
          ) : null}
          {expired ? (
            <span className="text-xs text-destructive" data-testid="browser-companion-expired">
              {t("expired")}
            </span>
          ) : null}
        </div>

        {code && !expired ? (
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">{t("codeLabel")}</p>
            <div className="flex items-start gap-2">
              <code
                className="min-w-0 flex-1 break-all rounded-control bg-muted px-2 py-1.5 font-mono text-[11px]"
                data-testid="browser-companion-code"
              >
                {code}
              </code>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="shrink-0"
                onClick={() => void onCopy()}
              >
                <CopyIcon className="size-3.5" aria-hidden="true" />
                {copied ? t("copied") : t("copy")}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">{t("singleUse")}</p>
            <p className="text-xs text-muted-foreground">{t("originHint")}</p>
          </div>
        ) : null}

        {error ? (
          <p className="text-xs text-destructive" data-testid="browser-companion-error">
            {error}
          </p>
        ) : null}

        <div className="space-y-1 border-t pt-3">
          <p className="flex items-center gap-1.5 text-xs font-medium">
            <MonitorSmartphoneIcon className="size-3.5" aria-hidden="true" />
            {t("pairedTitle")}
          </p>
          <p className="text-xs text-muted-foreground">{t("pairedHint")}</p>
          <Button asChild size="sm" variant="ghost" className="h-7 px-2 text-xs">
            <a href="/devices">{t("openDevices")}</a>
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
