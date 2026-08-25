"use client"

/**
 * Route-level error / not-found / global-error renderer.
 *
 * One bounded panel, not a stack of cards. The header (icon, title, category
 * chip, error id) and the footer (recovery + utility actions) are pinned
 * `shrink-0`; the only scrollable region is the middle detail band, so a
 * stack-heavy error never pushes the title or the recovery buttons out of the
 * clipped shell viewport. Inside that band the detail sections — message +
 * stack, diagnostics, recent errors — are flush rows separated by hairlines
 * rather than bordered cards nested in a card, which is what the layout used to
 * do (an outer card wrapping a destructive Alert card beside two more bordered
 * panels). Every App Router boundary gets the same affordances:
 *   - error classification with a tailored primary recovery action
 *     (reload for stale chunks, reconnect-and-retry for network failures,
 *     boundary reset otherwise)
 *   - an inline system-diagnostics card and recent-errors context panel
 *   - copy full report / report issue / export crash log (with inline
 *     "Copied" / "Exported" ticks that work without a Toaster)
 *   - retry, back to home, jump to /logs
 *
 * Lives outside `components/ui/` so the project-wide ≥90% coverage gate applies.
 *
 * `app/global-error.tsx` runs after the root layout itself has crashed, which
 * means `NextIntlClientProvider` and the router context are gone. Callers in
 * that scenario must pass `staticLocale="en"`; the dispatcher below then routes
 * to a static-copy renderer that doesn't touch the missing providers. Every new
 * sub-module takes resolved values as props (not provider hooks) so it renders
 * in that path too.
 */

import { useCallback, useEffect, useRef, useState } from "react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { useLocale, useTranslations } from "next-intl"
import {
  AlertTriangle,
  Check,
  Copy,
  DownloadCloud,
  Download,
  FileQuestion,
  Home,
  RefreshCw,
  RotateCw,
  ScrollText,
  ServerCrash,
  WifiOff,
  X,
} from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { ErrorStackSection, type ErrorStackCopy } from "./error-stack-section"
import { ErrorDiagnosticsCard, type ErrorDiagnosticsCopy } from "./error-diagnostics-card"
import { RecentErrorsPanel, type RecentErrorsCopy } from "./recent-errors-panel"
import { ErrorReportActions, type ErrorReportCopy } from "./error-report-actions"
import { useNetworkStatus } from "@/hooks/use-network-status"
import { useAutoRetryOnReconnect } from "@/hooks/use-auto-retry-on-reconnect"
import { classifyError, type ErrorCategory, type RecoveryKind } from "@/lib/error/classify-error"
import { exportCrashLogBundleNow } from "@/lib/logging/crash-log"
import { loggers } from "@cognia/logging"
import { cn } from "@/lib/utils"

export type ErrorPageVariant = "error" | "not-found" | "global-error"

export interface ErrorPageProps {
  variant: ErrorPageVariant
  error?: Error & { digest?: string }
  reset?: () => void
  /** Override the default i18n title. */
  title?: string
  /** Override the default i18n description. */
  description?: string
  /** Defaults to "/". */
  homeHref?: string
  /** Extra action buttons (e.g. workflows "Back to library"). */
  additionalActions?: React.ReactNode
  disableHome?: boolean
  disableRetry?: boolean
  disableCrashExport?: boolean
  /**
   * Use static English copy and skip `useTranslations` / `usePathname` entirely.
   * Required for `app/global-error.tsx` where neither the next-intl provider
   * nor the Next router context is mounted.
   */
  staticLocale?: "en"
  /**
   * Logger module recorded against the boundary trip. Defaults follow the
   * variant: "error" / "global-error" → app; "not-found" → ui.
   */
  subsystem?: keyof typeof loggers
  /** Test seam — override the crash-log export call. */
  exportCrashLogImpl?: typeof exportCrashLogBundleNow
  className?: string
}

interface ResolvedCopy {
  title: string
  description: string
  traceTitle: string
  showStack: string
  hideStack: string
  retry: string
  goHome: string
  exportCrashLog: string
  exportingCrashLog: string
  exportCrashLogSuccess: string
  exportCrashLogFailed: string
  openLogs: string
  errorIdLabel: string
  copyErrorId: string
  copyErrorIdSuccess: string
  copied: string
  exportedCrashLog: string
  reloadApp: string
  tryAgainWhenOnline: string
  cancelAutoRetry: string
  autoRetryIn: (seconds: number) => string
  categoryLabels: Record<ErrorCategory, string>
  categoryDescriptions: Partial<Record<ErrorCategory, string>>
  diagnostics: ErrorDiagnosticsCopy
  recentErrors: RecentErrorsCopy
  report: ErrorReportCopy
}

const STATIC_CATEGORY_LABELS: Record<ErrorCategory, string> = {
  "chunk-load": "Outdated app version",
  network: "Network error",
  offline: "Offline",
  render: "Application error",
  unknown: "Unknown error",
}

const STATIC_CATEGORY_DESCRIPTIONS: Partial<Record<ErrorCategory, string>> = {
  "chunk-load": "A newer version of Cognia is available. Reload to fetch the latest files.",
  network: "We couldn't reach the network. Check your connection and try again.",
  offline: "You appear to be offline. We'll retry automatically once you're back online.",
}

const STATIC_DIAGNOSTICS: ErrorDiagnosticsCopy = {
  title: "System diagnostics",
  appVersion: "App version",
  platform: "Platform",
  osVersion: "OS version",
  runtime: "Runtime",
  online: "Online",
  offline: "Offline",
  locale: "Locale",
  route: "Route",
  category: "Category",
  runtimeDesktop: "Desktop app",
  runtimeBrowser: "Browser",
}

const STATIC_RECENT_ERRORS: RecentErrorsCopy = {
  title: "Recent errors",
  cascadeHint: "Several errors occurred together — this may be a cascading failure.",
}

const STATIC_REPORT: ErrorReportCopy = {
  copyReport: "Copy full report",
  copyReportSuccess: "Report copied to clipboard",
  copyReportFailed: "Failed to copy report",
  reportIssue: "Report issue",
  reportIssueFailed: "Failed to open the issue tracker",
}

const STATIC_EN_BASE: Omit<
  ResolvedCopy,
  "title" | "description" | "categoryLabels" | "categoryDescriptions"
> = {
  traceTitle: "Error details",
  showStack: "Show stack trace",
  hideStack: "Hide stack trace",
  retry: "Try again",
  goHome: "Back to home",
  exportCrashLog: "Export crash log",
  exportingCrashLog: "Exporting…",
  exportCrashLogSuccess: "Crash log exported",
  exportCrashLogFailed: "Failed to export crash log",
  openLogs: "Open logs",
  errorIdLabel: "Error ID",
  copyErrorId: "Copy ID",
  copyErrorIdSuccess: "Error ID copied",
  copied: "Copied",
  exportedCrashLog: "Exported",
  reloadApp: "Reload app",
  tryAgainWhenOnline: "Try again",
  cancelAutoRetry: "Cancel",
  autoRetryIn: (seconds: number) => `Retrying in ${seconds}s…`,
  diagnostics: STATIC_DIAGNOSTICS,
  recentErrors: STATIC_RECENT_ERRORS,
  report: STATIC_REPORT,
}

function staticCopyFor(variant: ErrorPageVariant): ResolvedCopy {
  const base = {
    ...STATIC_EN_BASE,
    categoryLabels: STATIC_CATEGORY_LABELS,
    categoryDescriptions: STATIC_CATEGORY_DESCRIPTIONS,
  }
  if (variant === "not-found") {
    return {
      ...base,
      title: "Page not found",
      description:
        "We couldn't find the page you were looking for. It may have been moved, renamed, or deleted.",
    }
  }
  if (variant === "global-error") {
    return {
      ...base,
      title: "Cognia stopped working",
      description:
        "The application's main layout failed to load. Try recovering, or close the window using the title bar.",
    }
  }
  return {
    ...base,
    title: "Something went wrong",
    description:
      "An unexpected error occurred. The technical details below can help diagnose the issue.",
  }
}

function defaultSubsystem(variant: ErrorPageVariant): keyof typeof loggers {
  if (variant === "not-found") return "ui"
  return "app"
}

/**
 * A boolean that flips to `true` on `trigger()` and auto-resets after
 * `durationMs`. Powers the inline "Copied" / "Exported" confirmation ticks so
 * feedback survives even in the static global-error path where no Toaster is
 * mounted. The pending timer is cleared on unmount to avoid a late setState.
 */
function useTransientFlag(durationMs = 1600): [boolean, () => void] {
  const [flag, setFlag] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const trigger = useCallback(() => {
    setFlag(true)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setFlag(false), durationMs)
  }, [durationMs])
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    []
  )
  return [flag, trigger]
}

function HeadlineIcon({
  variant,
  category,
}: {
  variant: ErrorPageVariant
  category: ErrorCategory
}) {
  if (variant === "not-found") {
    return <FileQuestion className="size-5 text-muted-foreground" aria-hidden="true" />
  }
  if (variant === "global-error") {
    return <ServerCrash className="size-5 text-destructive" aria-hidden="true" />
  }
  if (category === "offline" || category === "network") {
    return <WifiOff className="size-5 text-destructive" aria-hidden="true" />
  }
  if (category === "chunk-load") {
    return <DownloadCloud className="size-5 text-warning" aria-hidden="true" />
  }
  return <AlertTriangle className="size-5 text-destructive" aria-hidden="true" />
}

/** Dot colour on the category chip — a chip, not a boxed badge, keeps the header flat. */
const CATEGORY_DOT: Record<ErrorCategory, string> = {
  "chunk-load": "bg-warning",
  network: "bg-warning",
  offline: "bg-muted-foreground",
  render: "bg-destructive",
  unknown: "bg-destructive",
}

/**
 * Dispatcher — picks the static or i18n-aware renderer based on the prop. The
 * dispatch happens at the call-site level so each renderer can call its own
 * hooks unconditionally (avoiding rules-of-hooks violations).
 */
export function ErrorPage(props: ErrorPageProps) {
  if (props.staticLocale === "en") {
    return <ErrorPageStatic {...props} />
  }
  return <ErrorPageIntl {...props} />
}

function ErrorPageIntl(props: ErrorPageProps) {
  const t = useTranslations("errorPage")
  const tNotFound = useTranslations("notFound")
  const pathname = usePathname()
  const locale = useLocale()

  const variantTitle =
    props.variant === "global-error"
      ? t("globalTitle")
      : props.variant === "not-found"
        ? tNotFound("title")
        : t("title")
  const variantDescription =
    props.variant === "global-error"
      ? t("globalDescription")
      : props.variant === "not-found"
        ? tNotFound("description")
        : t("description")
  const variantHome = props.variant === "not-found" ? tNotFound("goHome") : t("goHome")

  const categoryLabels: Record<ErrorCategory, string> = {
    "chunk-load": t("category.chunkLoad"),
    network: t("category.network"),
    offline: t("category.offline"),
    render: t("category.render"),
    unknown: t("category.unknown"),
  }

  const copy: ResolvedCopy = {
    title: props.title ?? variantTitle,
    description: props.description ?? variantDescription,
    traceTitle: t("traceTitle"),
    showStack: t("showStack"),
    hideStack: t("hideStack"),
    retry: t("retry"),
    goHome: variantHome,
    exportCrashLog: t("exportCrashLog"),
    exportingCrashLog: t("exportingCrashLog"),
    exportCrashLogSuccess: t("exportCrashLogSuccess"),
    exportCrashLogFailed: t("exportCrashLogFailed"),
    openLogs: t("openLogs"),
    errorIdLabel: t("errorIdLabel"),
    copyErrorId: t("copyErrorId"),
    copyErrorIdSuccess: t("copyErrorIdSuccess"),
    copied: t("copied"),
    exportedCrashLog: t("exportedCrashLog"),
    reloadApp: t("reloadApp"),
    tryAgainWhenOnline: t("tryAgainWhenOnline"),
    cancelAutoRetry: t("cancelAutoRetry"),
    autoRetryIn: (seconds: number) => t("autoRetryIn", { seconds }),
    categoryLabels,
    categoryDescriptions: {
      "chunk-load": t("categoryDescription.chunkLoad"),
      network: t("categoryDescription.network"),
      offline: t("categoryDescription.offline"),
    },
    diagnostics: {
      title: t("diagnostics.title"),
      appVersion: t("diagnostics.appVersion"),
      platform: t("diagnostics.platform"),
      osVersion: t("diagnostics.osVersion"),
      runtime: t("diagnostics.runtime"),
      online: t("diagnostics.online"),
      offline: t("diagnostics.offline"),
      locale: t("diagnostics.locale"),
      route: t("diagnostics.route"),
      category: t("diagnostics.category"),
      runtimeDesktop: t("diagnostics.runtimeDesktop"),
      runtimeBrowser: t("diagnostics.runtimeBrowser"),
    },
    recentErrors: {
      title: t("recentErrors.title"),
      cascadeHint: t("recentErrors.cascadeHint"),
    },
    report: {
      copyReport: t("report.copyReport"),
      copyReportSuccess: t("report.copyReportSuccess"),
      copyReportFailed: t("report.copyReportFailed"),
      reportIssue: t("report.reportIssue"),
      reportIssueFailed: t("report.reportIssueFailed"),
    },
  }

  return <ErrorPageShell {...props} copy={copy} pathname={pathname} locale={locale} toastsEnabled />
}

function ErrorPageStatic(props: ErrorPageProps) {
  const base = staticCopyFor(props.variant)
  const copy: ResolvedCopy = {
    ...base,
    title: props.title ?? base.title,
    description: props.description ?? base.description,
  }
  return <ErrorPageShell {...props} copy={copy} pathname={null} locale="en" toastsEnabled={false} />
}

interface ErrorPageShellProps extends ErrorPageProps {
  copy: ResolvedCopy
  pathname: string | null
  locale: string
  toastsEnabled: boolean
}

function ErrorPageShell({
  variant,
  error,
  reset,
  homeHref = "/",
  additionalActions,
  disableHome,
  disableRetry,
  disableCrashExport,
  subsystem,
  exportCrashLogImpl,
  className,
  copy,
  pathname,
  locale,
  toastsEnabled,
  description: descriptionProp,
}: ErrorPageShellProps) {
  const [exporting, setExporting] = useState(false)
  const [copiedId, flashCopiedId] = useTransientFlag()
  const [exported, flashExported] = useTransientFlag()
  const { status } = useNetworkStatus()
  const online = status.connected

  const { category, recoveryKind } = classifyError(error, { online })

  useEffect(() => {
    const scope = subsystem ?? defaultSubsystem(variant)
    const logger = loggers[scope]
    if (variant === "not-found") {
      logger.debug("Route not found", {
        pathname,
        digest: error?.digest,
      })
      return
    }
    const recordedError =
      error ?? new Error(variant === "global-error" ? "Global layout error" : "Route error")
    const level = variant === "global-error" ? "fatal" : "error"
    logger[level]("Route boundary tripped", recordedError, {
      variant,
      category,
      pathname,
      digest: error?.digest,
    })
  }, [error, pathname, subsystem, variant, category])

  const isNotFound = variant === "not-found"
  const showCrashExport = !isNotFound && !disableCrashExport
  const showRetry = !!reset && !disableRetry
  const showTrace = !isNotFound && !!error
  const showAuxiliary = !isNotFound
  const showHome = !disableHome
  // Detail sections live in the scrollable middle band; when there are none
  // (e.g. not-found) the card collapses to a compact header + action footer.
  const hasBody = showTrace || showAuxiliary
  const showCategoryBadge = !isNotFound

  // Auto-retry on reconnect for connectivity errors (hook is inert otherwise).
  const autoRetry = useAutoRetryOnReconnect({
    enabled: showRetry && recoveryKind === "retry-online",
    online,
    onRetry: reset ?? (() => {}),
  })

  // Tailor the description to the classified category when the caller didn't
  // override it (error variant only — not-found / global keep their copy).
  const resolvedDescription =
    descriptionProp ??
    (variant === "error" ? copy.categoryDescriptions[category] : undefined) ??
    copy.description

  const handleExport = useCallback(async () => {
    if (exporting) return
    setExporting(true)
    try {
      const impl = exportCrashLogImpl ?? exportCrashLogBundleNow
      await impl({
        triggerError: error,
        subsystem: (subsystem as string | undefined) ?? defaultSubsystem(variant),
      })
      flashExported()
      if (toastsEnabled) {
        toast.success(copy.exportCrashLogSuccess)
      }
    } catch (err) {
      const scope = subsystem ?? defaultSubsystem(variant)
      loggers[scope].error("Crash log export failed", err)
      if (toastsEnabled) {
        toast.error(copy.exportCrashLogFailed)
      }
    } finally {
      setExporting(false)
    }
  }, [
    copy.exportCrashLogFailed,
    copy.exportCrashLogSuccess,
    error,
    exportCrashLogImpl,
    exporting,
    flashExported,
    subsystem,
    toastsEnabled,
    variant,
  ])

  const handleCopyErrorId = useCallback(async () => {
    if (!error?.digest) return
    try {
      await navigator.clipboard.writeText(error.digest)
      flashCopiedId()
      if (toastsEnabled) {
        toast.success(copy.copyErrorIdSuccess)
      }
    } catch {
      /* clipboard denied — silent */
    }
  }, [copy.copyErrorIdSuccess, error, flashCopiedId, toastsEnabled])

  const handleReload = useCallback(() => {
    window.location.reload()
  }, [])

  const primaryRetryLabel: Record<RecoveryKind, string> = {
    reload: copy.reloadApp,
    "retry-online": copy.tryAgainWhenOnline,
    reset: copy.retry,
  }

  const stackCopy: ErrorStackCopy = {
    title: copy.traceTitle,
    showStack: copy.showStack,
    hideStack: copy.hideStack,
  }

  return (
    <div
      role="alert"
      data-testid="error-page"
      data-variant={variant}
      data-category={category}
      className={cn("flex h-full w-full items-center justify-center p-4 sm:p-6", className)}
    >
      {/*
        Bounded panel: `max-h-full` keeps it inside the (overflow-hidden) shell
        viewport, the header/footer are `shrink-0` so recovery actions and the
        title never scroll away, and only the middle detail band scrolls when an
        error carries a lot of information.
      */}
      <div
        className={cn(
          "flex max-h-full w-full max-w-lg flex-col overflow-hidden rounded-2xl border bg-card text-card-foreground shadow-sm",
          hasBody && "max-w-2xl"
        )}
      >
        {/* Header — always visible. Icon tile beside the copy, not stacked above
            it: the centred hero wasted the vertical room the detail band needs. */}
        <div className="flex shrink-0 items-start gap-3.5 px-5 pt-5 pb-4">
          <span
            className={cn(
              "flex size-10 shrink-0 items-center justify-center rounded-xl",
              isNotFound ? "bg-muted" : "bg-destructive/10"
            )}
          >
            <HeadlineIcon variant={variant} category={category} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <h1 className="text-base font-semibold tracking-tight">{copy.title}</h1>
              {showCategoryBadge && (
                <span
                  className="inline-flex items-center gap-1.5 rounded-pill bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground"
                  data-testid="error-page-category"
                >
                  <span
                    className={cn("size-1.5 rounded-full", CATEGORY_DOT[category])}
                    aria-hidden="true"
                  />
                  {copy.categoryLabels[category]}
                </span>
              )}
            </div>
            <p className="mt-1.5 text-sm text-pretty text-muted-foreground">
              {resolvedDescription}
            </p>
            {error?.digest && (
              <div
                className="mt-2.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground"
                data-testid="error-page-id"
              >
                <span>{copy.errorIdLabel}</span>
                <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-foreground">
                  {error.digest}
                </code>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 gap-1 px-1.5 text-[11px]"
                  onClick={handleCopyErrorId}
                  data-testid="error-page-copy-id"
                >
                  {copiedId ? (
                    <Check className="size-3 text-success" aria-hidden="true" />
                  ) : (
                    <Copy className="size-3" aria-hidden="true" />
                  )}
                  {copiedId ? copy.copied : copy.copyErrorId}
                </Button>
              </div>
            )}
          </div>
        </div>

        {/* Detail band — the only scrollable region. Flush sections split by
            hairlines; no nested cards and no nested scrollbars. */}
        {hasBody && (
          <div
            className="min-h-0 flex-1 divide-y overflow-y-auto border-t"
            data-testid="error-page-body"
          >
            {showTrace && <ErrorStackSection error={error!} copy={stackCopy} />}
            {showAuxiliary && (
              <>
                <ErrorDiagnosticsCard
                  copy={copy.diagnostics}
                  categoryLabel={copy.categoryLabels[category]}
                  locale={locale}
                  pathname={pathname}
                />
                <RecentErrorsPanel copy={copy.recentErrors} currentErrorId={error?.digest} />
              </>
            )}
          </div>
        )}

        {/* Footer — always visible: utilities on the left, recovery on the right */}
        <div className="flex shrink-0 flex-col gap-2 border-t px-5 py-3">
          {autoRetry.pending && (
            <div
              className="flex items-center gap-2 text-xs text-muted-foreground"
              data-testid="error-page-auto-retry"
            >
              <RotateCw className="size-3.5 animate-spin" aria-hidden="true" />
              <span>{copy.autoRetryIn(autoRetry.secondsLeft)}</span>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 gap-1 px-1.5 text-xs"
                onClick={autoRetry.cancel}
                data-testid="error-page-cancel-auto-retry"
              >
                <X className="size-3" aria-hidden="true" />
                {copy.cancelAutoRetry}
              </Button>
            </div>
          )}

          <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-2">
            {/* Secondary utilities — lower emphasis, wrap freely */}
            <div className="-ml-2 flex flex-wrap items-center gap-0.5 text-muted-foreground">
              {showAuxiliary && (
                <ErrorReportActions
                  error={error}
                  copy={copy.report}
                  context={{ category, locale, pathname }}
                  toastsEnabled={toastsEnabled}
                />
              )}
              {showCrashExport && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleExport}
                  disabled={exporting}
                  className="h-8 gap-1.5 px-2 text-xs"
                  data-testid="error-page-export"
                >
                  {exported ? (
                    <Check className="size-3.5 text-success" aria-hidden="true" />
                  ) : (
                    <Download className="size-3.5" aria-hidden="true" />
                  )}
                  {exporting
                    ? copy.exportingCrashLog
                    : exported
                      ? copy.exportedCrashLog
                      : copy.exportCrashLog}
                </Button>
              )}
              <Button
                variant="ghost"
                size="sm"
                asChild
                className="h-8 gap-1.5 px-2 text-xs"
                data-testid="error-page-open-logs"
              >
                <Link href="/logs">
                  <ScrollText className="size-3.5" aria-hidden="true" />
                  {copy.openLogs}
                </Link>
              </Button>
            </div>

            {/* Primary recovery actions */}
            <div className="ml-auto flex flex-wrap items-center gap-2">
              {additionalActions}
              {showHome && (
                <Button
                  variant="outline"
                  size="sm"
                  asChild
                  className="gap-2"
                  data-testid="error-page-home"
                >
                  <Link href={homeHref}>
                    <Home className="size-4" aria-hidden="true" />
                    {copy.goHome}
                  </Link>
                </Button>
              )}
              {showRetry && (
                <Button
                  size="sm"
                  onClick={recoveryKind === "reload" ? handleReload : reset}
                  className="gap-2"
                  data-testid="error-page-retry"
                >
                  {recoveryKind === "reload" ? (
                    <RotateCw className="size-4" aria-hidden="true" />
                  ) : (
                    <RefreshCw className="size-4" aria-hidden="true" />
                  )}
                  {primaryRetryLabel[recoveryKind]}
                </Button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
