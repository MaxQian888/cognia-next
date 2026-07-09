"use client"

/**
 * Route-level error / not-found / global-error renderer.
 *
 * Renders a bounded card whose header (icon, title, category badge, error id)
 * and footer (recovery + utility actions) are pinned `shrink-0`, with the only
 * scrollable region being the middle detail band — so a stack-heavy error
 * never pushes the title or the recovery buttons out of the clipped shell
 * viewport. The band lays `ErrorTraceDetails` (Alert + collapsible stack) beside
 * the diagnostics / recent-errors panels in two columns on wide screens and
 * stacks them on narrow ones. Every App Router boundary gets the same
 * affordances:
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

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { EmptyDescription, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { ErrorTraceDetails } from "@/components/ai-elements/error-trace"
import { ErrorDiagnosticsCard, type ErrorDiagnosticsCopy } from "./error-diagnostics-card"
import { RecentErrorsPanel, type RecentErrorsCopy } from "./recent-errors-panel"
import { ErrorReportActions, type ErrorReportCopy } from "./error-report-actions"
import { useNetworkStatus } from "@/hooks/use-network-status"
import { useAutoRetryOnReconnect } from "@/hooks/use-auto-retry-on-reconnect"
import { classifyError, type ErrorCategory, type RecoveryKind } from "@/lib/error/classify-error"
import { exportCrashLogBundleNow } from "@/lib/logging/crash-log"
import { loggers } from "@/lib/logging"
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
}

const STATIC_EN_BASE: Omit<
  ResolvedCopy,
  "title" | "description" | "categoryLabels" | "categoryDescriptions"
> = {
  traceTitle: "Error details",
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
    return <FileQuestion className="size-6 text-muted-foreground" aria-hidden="true" />
  }
  if (variant === "global-error") {
    return <ServerCrash className="size-6 text-destructive" aria-hidden="true" />
  }
  if (category === "offline" || category === "network") {
    return <WifiOff className="size-6 text-destructive" aria-hidden="true" />
  }
  if (category === "chunk-load") {
    return <DownloadCloud className="size-6 text-warning" aria-hidden="true" />
  }
  return <AlertTriangle className="size-6 text-destructive" aria-hidden="true" />
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

  return (
    <div
      role="alert"
      data-testid="error-page"
      data-variant={variant}
      data-category={category}
      className={cn("flex h-full w-full items-center justify-center p-4 sm:p-6", className)}
    >
      {/*
        Bounded card: `max-h-full` keeps it inside the (overflow-hidden) shell
        viewport, the header/footer are `shrink-0` so recovery actions and the
        title never scroll away, and only the middle detail band scrolls when an
        error carries a lot of information.
      */}
      <div
        className={cn(
          "flex max-h-full w-full max-w-2xl flex-col overflow-hidden rounded-xl border bg-card text-card-foreground shadow-sm",
          hasBody && "lg:max-w-4xl"
        )}
      >
        {/* Header — always visible */}
        <div className="flex shrink-0 flex-col items-center gap-3 px-6 pt-8 pb-5 text-center">
          <EmptyMedia variant="icon" className={cn("bg-destructive/10", isNotFound && "bg-muted")}>
            <HeadlineIcon variant={variant} category={category} />
          </EmptyMedia>
          <div className="flex flex-col items-center gap-2">
            <EmptyTitle className="text-xl">{copy.title}</EmptyTitle>
            {showCategoryBadge && (
              <Badge variant="secondary" className="font-normal" data-testid="error-page-category">
                {copy.categoryLabels[category]}
              </Badge>
            )}
            <EmptyDescription className="mx-auto max-w-xl text-balance">
              {resolvedDescription}
            </EmptyDescription>
          </div>
          {error?.digest && (
            <div
              className="flex flex-wrap items-center justify-center gap-2 text-xs text-muted-foreground"
              data-testid="error-page-id"
            >
              <span className="font-medium">{copy.errorIdLabel}:</span>
              <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">
                {error.digest}
              </code>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 gap-1 px-2 text-[11px]"
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

        {/* Detail band — the only scrollable region; two columns on wide screens */}
        {hasBody && (
          <div
            className="min-h-0 flex-1 overflow-y-auto border-t px-6 py-4"
            data-testid="error-page-body"
          >
            <div className="grid gap-3 lg:grid-cols-5 lg:items-start">
              {showTrace && (
                <div className={cn("min-w-0", showAuxiliary ? "lg:col-span-3" : "lg:col-span-5")}>
                  <ErrorTraceDetails
                    error={error!}
                    title={copy.traceTitle}
                    className="w-full text-left"
                  />
                </div>
              )}
              {showAuxiliary && (
                <div
                  className={cn(
                    "flex min-w-0 flex-col gap-3",
                    showTrace ? "lg:col-span-2" : "lg:col-span-5"
                  )}
                >
                  <ErrorDiagnosticsCard
                    copy={copy.diagnostics}
                    categoryLabel={copy.categoryLabels[category]}
                    locale={locale}
                    pathname={pathname}
                  />
                  <RecentErrorsPanel copy={copy.recentErrors} currentErrorId={error?.digest} />
                </div>
              )}
            </div>
          </div>
        )}

        {/* Footer — always visible: recovery actions + secondary utilities */}
        <div className="flex shrink-0 flex-col gap-3 border-t bg-card px-6 py-4">
          {autoRetry.pending && (
            <div
              className="flex items-center justify-center gap-2 text-sm text-muted-foreground"
              data-testid="error-page-auto-retry"
            >
              <RotateCw className="size-3.5 animate-spin" aria-hidden="true" />
              <span>{copy.autoRetryIn(autoRetry.secondsLeft)}</span>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 gap-1 px-2"
                onClick={autoRetry.cancel}
                data-testid="error-page-cancel-auto-retry"
              >
                <X className="size-3" aria-hidden="true" />
                {copy.cancelAutoRetry}
              </Button>
            </div>
          )}

          {/* Primary recovery actions */}
          <div className="flex flex-wrap items-center justify-center gap-2">
            {showRetry && (
              <Button
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
            {showHome && (
              <Button variant="outline" asChild className="gap-2" data-testid="error-page-home">
                <Link href={homeHref}>
                  <Home className="size-4" aria-hidden="true" />
                  {copy.goHome}
                </Link>
              </Button>
            )}
            {additionalActions}
          </div>

          {/* Secondary utilities — lower emphasis, wrap freely */}
          <div className="flex flex-wrap items-center justify-center gap-1 text-muted-foreground">
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
                className="gap-2"
                data-testid="error-page-export"
              >
                {exported ? (
                  <Check className="size-4 text-success" aria-hidden="true" />
                ) : (
                  <Download className="size-4" aria-hidden="true" />
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
              className="gap-2"
              data-testid="error-page-open-logs"
            >
              <Link href="/logs">
                <ScrollText className="size-4" aria-hidden="true" />
                {copy.openLogs}
              </Link>
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
