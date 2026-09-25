"use client"

import { useCallback, useEffect, useReducer, useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { CopyIcon, HistoryIcon, MonitorSmartphoneIcon, PuzzleIcon } from "lucide-react"
import { useTranslations } from "next-intl"

import { encodeBrowserEnrollmentPayload } from "@cognia/companion-client"
import { Alert, AlertDescription } from "@/components/ui/alert"
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
import { SettingsBlock } from "@/components/settings/common/settings-block"
import {
  clearBrowserSubmissions,
  pruneBrowserSubmissions,
  summarizeBrowserSubmissions,
} from "@/lib/db/browser-submissions"
import { useSurfaceReach } from "@/hooks/platform/use-surface-reach"
import { localTransport as transport } from "@/lib/tauri"

/** Mirrors Rust `companion_api::commands::BrowserEnrollmentIssue`. */
export interface BrowserEnrollmentIssue {
  enrollment: string
  expiresAtMs: number
  baseUrl: string
  tenantId: string
}

/** The subset of `BrowserAccessSummary` this card needs. */
interface BrowserAccessListenerState {
  /** Whether the user has switched Browser Access on. */
  enabled: boolean
  /**
   * The port actually bound. It outlives the switch: turning Browser Access
   * off leaves the listener bound until the server restarts, so a port on its
   * own does not mean this Host is accepting browsers.
   */
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
  /** Test seam — defaults to the real retention sweep. */
  pruneHistory?: () => Promise<number>
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
  now = Date.now,
  loadHistory = summarizeBrowserSubmissions,
  clearHistory = clearBrowserSubmissions,
  pruneHistory = pruneBrowserSubmissions,
}: BrowserCompanionCardProps = {}) {
  const t = useTranslations("mobile.companion.browserCompanion")
  // The listener and the enrolment code both live in the desktop process. A
  // browser tab or a phone is told so below; it is not shown a blank.
  const shellReach = useSurfaceReach({ capability: "webview", requirement: "desktop-shell" })
  const desktopShell = shellReach.available
  // `disabled`: the switch is off. `stopped`: it is on, and nothing is bound
  // yet — the server has to restart for the listener to come up. Different
  // remedies, so different sentences.
  const [listening, setListening] = useState<
    "loading" | "disabled" | "stopped" | "ready" | "failed"
  >("loading")
  const [issue, setIssue] = useState<BrowserEnrollmentIssue | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [clearing, setClearing] = useState(false)
  const [cleared, setCleared] = useState(false)
  const [confirmingClear, setConfirmingClear] = useState(false)
  // Bumped after a clear, so a history reader that is not a Dexie query (a
  // test seam, or anything injected) is re-asked as well. A real Dexie reader
  // is re-run by the live query on its own.
  const [historyRevision, bumpHistoryRevision] = useReducer((tick: number) => tick + 1, 0)
  const [, refreshExpiry] = useReducer((tick: number) => tick + 1, 0)

  useEffect(() => {
    if (!issue) return
    const timer = window.setInterval(() => {
      refreshExpiry()
      if (now() >= issue.expiresAtMs) window.clearInterval(timer)
    }, 1000)
    return () => window.clearInterval(timer)
  }, [issue, now])

  useEffect(() => {
    if (!desktopShell) return
    let cancelled = false
    void loadListener()
      .then((summary) => {
        if (cancelled) return
        // Both, never the port alone. A switched-off Host keeps its port until
        // the server restarts, and the Rust command refuses to mint a code for
        // it — so a card that read only the port offered a button that could
        // only fail.
        setListening(
          !summary.enabled ? "disabled" : summary.boundPort !== null ? "ready" : "stopped"
        )
      })
      .catch(() => {
        if (!cancelled) setListening("failed")
      })
    return () => {
      cancelled = true
    }
  }, [desktopShell, loadListener])

  // Apply retention once when the card opens, so the count below never
  // includes rows the Host already considers expired. Separate from the live
  // query because a live query is a read: Dexie refuses writes inside one.
  useEffect(() => {
    if (!desktopShell) return
    void pruneHistory().catch(() => undefined)
  }, [desktopShell, pruneHistory])

  // Live, so a submission arriving from a browser while this pane is open is
  // counted without reopening it. `null` is "could not be read", which the
  // card must not render as "empty"; `undefined` is "not answered yet".
  const history = useLiveQuery(async (): Promise<{ deviceIds: string[]; total: number } | null> => {
    if (!desktopShell) return null
    try {
      return await loadHistory()
    } catch {
      return null
    }
  }, [desktopShell, loadHistory, historyRevision])

  /**
   * Forget every recorded submission, one device at a time.
   *
   * Looped rather than a single unscoped delete because device scoping is the
   * table's security property, not an optimisation: `clearBrowserSubmissions`
   * is the only delete a person asks for, and a bulk path beside it would be a
   * second one that no longer has to name whose rows it is removing.
   * (Retention also deletes, by age and count only — never by choice.)
   */
  const clearAll = useCallback(async () => {
    setConfirmingClear(false)
    if (!history || history.total === 0) return
    setClearing(true)
    setCleared(false)
    try {
      setError(null)
      for (const deviceId of history.deviceIds) await clearHistory(deviceId)
      bumpHistoryRevision()
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
  }, [clearHistory, history, t])

  const generate = useCallback(async () => {
    if (!desktopShell || listening !== "ready") return
    setBusy(true)
    setCopied(false)
    setIssue(null)
    try {
      setError(null)
      setIssue(await createEnrollment())
    } catch {
      // The two refusals whose remedy is another control — not listening,
      // switched off — are ruled out before this button is enabled, and said
      // above it in the user's language. What is left is a store failure, and
      // the Rust message for that is English diagnostics, not a sentence.
      setError(t("generateFailed"))
    } finally {
      setBusy(false)
    }
  }, [createEnrollment, desktopShell, listening, t])

  if (!desktopShell) {
    // Rendered with the reason, never hidden: a missing card reads as "this
    // build does not have the feature", which is a different answer from
    // "open the desktop app".
    return (
      <SettingsBlock
        icon={<PuzzleIcon />}
        title={t("title")}
        description={t("description")}
        testid="browser-companion-card"
        settingId="companion-browser-companion"
        attributes={{ "data-reach": shellReach.block ?? "unavailable" }}
        contentClassName="text-xs text-muted-foreground"
      >
        <p data-testid="browser-companion-desktop-only">{t("desktopOnly")}</p>
      </SettingsBlock>
    )
  }

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
    if (!code || !issue || now() >= issue.expiresAtMs) return
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
    <SettingsBlock
      icon={<PuzzleIcon />}
      title={t("title")}
      description={t("description")}
      testid="browser-companion-card"
      settingId="companion-browser-companion"
      contentClassName="space-y-4 text-sm"
    >
      {/* Rendered as a disabled control with the reason beside it, never
            hidden: a missing button reads as "this build does not have the
            feature", which is a different answer from "one switch away". */}
      {listening === "disabled" ? (
        <Alert data-testid="browser-companion-needs-listener">
          <AlertDescription>{t("requiresListener")}</AlertDescription>
        </Alert>
      ) : null}
      {listening === "stopped" ? (
        <Alert data-testid="browser-companion-needs-restart">
          <AlertDescription>{t("requiresRestart")}</AlertDescription>
        </Alert>
      ) : null}
      {listening === "failed" ? (
        <Alert variant="destructive" data-testid="browser-companion-listener-error">
          <AlertDescription>{t("listenerFailed")}</AlertDescription>
        </Alert>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant={issue ? "outline" : "default"}
          disabled={busy || listening !== "ready"}
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
            onClick={() => setConfirmingClear(true)}
            data-testid="browser-companion-clear-history"
          >
            {clearing ? t("historyClearing") : cleared ? t("historyCleared") : t("historyClear")}
          </Button>
          {/* Asked first: the rows are the only record of which browser sent
              what, and there is no undo. The conversations they point at are
              not touched, and the question says so. */}
          <AlertDialog open={confirmingClear} onOpenChange={setConfirmingClear}>
            <AlertDialogContent data-testid="browser-companion-clear-dialog">
              <AlertDialogHeader>
                <AlertDialogTitle>{t("historyClearConfirmTitle")}</AlertDialogTitle>
                <AlertDialogDescription>
                  {t("historyClearConfirmDescription", { count: history.total })}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>{t("historyClearCancel")}</AlertDialogCancel>
                <AlertDialogAction
                  variant="destructive"
                  onClick={() => void clearAll()}
                  data-testid="browser-companion-clear-confirm"
                >
                  {t("historyClearConfirm")}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      ) : null}

      {/* A sentence, not a second link: the pairing panel renders the device
          console link directly below this card, and two links to one place
          side by side read as two different places. */}
      <div className="space-y-1 border-t pt-3">
        <p className="flex items-center gap-1.5 text-xs font-medium">
          <MonitorSmartphoneIcon className="size-3.5" aria-hidden="true" />
          {t("pairedTitle")}
        </p>
        <p className="text-xs text-muted-foreground">{t("pairedHint")}</p>
      </div>
    </SettingsBlock>
  )
}
