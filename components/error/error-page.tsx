"use client"

/**
 * Route-level error / not-found / global-error renderer.
 *
 * Composes the shadcn `Empty` layout primitive with `ErrorTraceDetails` (Alert
 * + Collapsible stack from ai-elements) and the recent-errors / crash-log
 * pipeline so every App Router boundary surfaces the same affordances:
 *   - retry (`reset`)
 *   - back to home
 *   - export crash log (bundles this error + recent + persisted + diagnostics)
 *   - jump to /logs
 *
 * Lives outside `components/ui/` so the project-wide ≥90% coverage gate applies.
 *
 * `app/global-error.tsx` runs after the root layout itself has crashed, which
 * means `NextIntlClientProvider` and the router context are gone. Callers in
 * that scenario must pass `staticLocale="en"`; the dispatcher below then routes
 * to a static-copy renderer that doesn't touch the missing providers.
 */

import { useCallback, useEffect, useState } from "react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { useTranslations } from "next-intl"
import {
  AlertTriangle,
  Download,
  FileQuestion,
  Home,
  RefreshCw,
  ScrollText,
  ServerCrash,
} from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { ErrorTraceDetails } from "@/components/ai-elements/error-trace"
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
}

const STATIC_EN_BASE: Omit<ResolvedCopy, "title" | "description"> = {
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
}

function staticCopyFor(variant: ErrorPageVariant): ResolvedCopy {
  if (variant === "not-found") {
    return {
      ...STATIC_EN_BASE,
      title: "Page not found",
      description:
        "We couldn't find the page you were looking for. It may have been moved, renamed, or deleted.",
    }
  }
  if (variant === "global-error") {
    return {
      ...STATIC_EN_BASE,
      title: "Cognia stopped working",
      description:
        "The application's main layout failed to load. Try recovering, or close the window using the title bar.",
    }
  }
  return {
    ...STATIC_EN_BASE,
    title: "Something went wrong",
    description:
      "An unexpected error occurred. The technical details below can help diagnose the issue.",
  }
}

function defaultSubsystem(variant: ErrorPageVariant): keyof typeof loggers {
  if (variant === "not-found") return "ui"
  return "app"
}

function VariantIcon({ variant }: { variant: ErrorPageVariant }) {
  if (variant === "not-found") {
    return <FileQuestion className="size-6 text-muted-foreground" aria-hidden="true" />
  }
  if (variant === "global-error") {
    return <ServerCrash className="size-6 text-destructive" aria-hidden="true" />
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

  const base = staticCopyFor(props.variant)
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

  const copy: ResolvedCopy = {
    ...base,
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
  }

  return <ErrorPageShell {...props} copy={copy} pathname={pathname} toastsEnabled />
}

function ErrorPageStatic(props: ErrorPageProps) {
  const base = staticCopyFor(props.variant)
  const copy: ResolvedCopy = {
    ...base,
    title: props.title ?? base.title,
    description: props.description ?? base.description,
  }
  return <ErrorPageShell {...props} copy={copy} pathname={null} toastsEnabled={false} />
}

interface ErrorPageShellProps extends ErrorPageProps {
  copy: ResolvedCopy
  pathname: string | null
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
  toastsEnabled,
}: ErrorPageShellProps) {
  const [exporting, setExporting] = useState(false)

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
      pathname,
      digest: error?.digest,
    })
  }, [error, pathname, subsystem, variant])

  const showCrashExport = variant !== "not-found" && !disableCrashExport
  const showRetry = !!reset && !disableRetry
  const showHome = !disableHome
  const showTrace = variant !== "not-found" && !!error

  const handleExport = useCallback(async () => {
    if (exporting) return
    setExporting(true)
    try {
      const impl = exportCrashLogImpl ?? exportCrashLogBundleNow
      await impl({
        triggerError: error,
        subsystem: (subsystem as string | undefined) ?? defaultSubsystem(variant),
      })
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
    subsystem,
    toastsEnabled,
    variant,
  ])

  const handleCopyErrorId = useCallback(async () => {
    if (!error?.digest) return
    try {
      await navigator.clipboard.writeText(error.digest)
      if (toastsEnabled) {
        toast.success(copy.copyErrorIdSuccess)
      }
    } catch {
      /* clipboard denied — silent */
    }
  }, [copy.copyErrorIdSuccess, error, toastsEnabled])

  return (
    <div
      role="alert"
      data-testid="error-page"
      data-variant={variant}
      className={cn(
        "flex h-full min-h-[60vh] w-full items-center justify-center px-4 py-8",
        className
      )}
    >
      <Empty className="mx-auto w-full max-w-2xl border-0">
        <EmptyHeader>
          <EmptyMedia
            variant="icon"
            className={cn("bg-destructive/10", variant === "not-found" && "bg-muted")}
          >
            <VariantIcon variant={variant} />
          </EmptyMedia>
          <EmptyTitle>{copy.title}</EmptyTitle>
          <EmptyDescription>{copy.description}</EmptyDescription>
        </EmptyHeader>
        <EmptyContent className="max-w-xl">
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
                className="h-6 px-2 text-[11px]"
                onClick={handleCopyErrorId}
                data-testid="error-page-copy-id"
              >
                {copy.copyErrorId}
              </Button>
            </div>
          )}
          {showTrace && (
            <ErrorTraceDetails
              error={error!}
              title={copy.traceTitle}
              className="w-full text-left"
            />
          )}
          <div className="flex flex-wrap items-center justify-center gap-2">
            {showRetry && (
              <Button onClick={reset} className="gap-2" data-testid="error-page-retry">
                <RefreshCw className="size-4" aria-hidden="true" />
                {copy.retry}
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
            {showCrashExport && (
              <Button
                variant="ghost"
                onClick={handleExport}
                disabled={exporting}
                className="gap-2"
                data-testid="error-page-export"
              >
                <Download className="size-4" aria-hidden="true" />
                {exporting ? copy.exportingCrashLog : copy.exportCrashLog}
              </Button>
            )}
            <Button variant="ghost" asChild className="gap-2" data-testid="error-page-open-logs">
              <Link href="/logs">
                <ScrollText className="size-4" aria-hidden="true" />
                {copy.openLogs}
              </Link>
            </Button>
            {additionalActions}
          </div>
        </EmptyContent>
      </Empty>
    </div>
  )
}
