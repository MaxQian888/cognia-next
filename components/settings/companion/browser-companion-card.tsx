"use client"

import { useCallback, useEffect, useState } from "react"
import { CopyIcon, HistoryIcon, MonitorSmartphoneIcon, PuzzleIcon } from "lucide-react"
import { useTranslations } from "next-intl"

import { encodeBrowserEnrollmentPayload } from "@cognia/companion-client"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { clearBrowserSubmissions, summarizeBrowserSubmissions } from "@/lib/db/browser-submissions"
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
  /** Test seam — defaults to the real Dexie reader. */
  loadHistory?: () => Promise<{ deviceIds: string[]; total: number }>
  /** Test seam — defaults to the real device-scoped delete. */
  clearHistory?: (deviceId: string) => Promise<number>
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
  loadHistory = summarizeBrowserSubmissions,
  clearHistory = clearBrowserSubmissions,
}: BrowserCompanionCardProps = {}) {
  const t = useTranslations("mobile.companion.browserCompanion")
  const [listening, setListening] = useState<boolean | null>(null)
  const [issue, setIssue] = useState<BrowserEnrollmentIssue | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [history, setHistory] = useState<{ deviceIds: string[]; total: number } | null>(null)
  const [clearing, setClearing] = useState(false)
  const [cleared, setCleared] = useState(false)

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

  useEffect(() => {
    if (!isTauri()) return
    let cancelled = false
    void loadHistory()
      .then((summary) => {
        if (!cancelled) setHistory(summary)
      })
      .catch(() => {
        // A history the card cannot read is one it must not claim is empty.
        if (!cancelled) setHistory(null)
      })
    return () => {
      cancelled = true
    }
  }, [loadHistory])

  /**
   * Forget every recorded submission, one device at a time.
   *
   * Looped rather than a single unscoped delete because device scoping is the
   * table's security property, not an optimisation: `clearBrowserSubmissions`
   * is the only writer that deletes from it, and a bulk path beside it would be
   * a second one that no longer has to name whose rows it is removing.
   */
  const clearAll = useCallback(async () => {
    if (!history || history.total === 0) return
    setClearing(true)
    setCleared(false)
    try {
      setError(null)
      for (const deviceId of history.deviceIds) await clearHistory(deviceId)
      setHistory(await loadHistory())
      setCleared(true)
    } catch {
      // A Dexie failure message is not a sentence anybody can act on, and
      // unlike the enrollment refusal above there is no Host-authored
      // explanation to pass through — the remedy is "try again", not a
      // different switch.
      setError(t("historyClearFailed"))
    } finally {
      setClearing(false)
    }
  }, [clearHistory, history, loadHistory, t])

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

        {/* Rendered whenever the history is readable, including at zero. A
            control that appeared only once something had been recorded would
            make "nothing has been sent from a browser" and "this Host does not
            keep a record" look identical. */}
        {history ? (
          <div className="space-y-1 border-t pt-3" data-testid="browser-companion-history">
            <p className="flex items-center gap-1.5 text-xs font-medium">
              <HistoryIcon className="size-3.5" aria-hidden="true" />
              {t("historyTitle")}
            </p>
            <p
              className="text-xs text-muted-foreground"
              data-testid="browser-companion-history-count"
            >
              {t("historyCount", { count: history.total })}
            </p>
            <p className="text-xs text-muted-foreground">{t("historyHint")}</p>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-xs"
              disabled={clearing || history.total === 0}
              onClick={() => void clearAll()}
              data-testid="browser-companion-clear-history"
            >
              {clearing ? t("historyClearing") : cleared ? t("historyCleared") : t("historyClear")}
            </Button>
          </div>
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
