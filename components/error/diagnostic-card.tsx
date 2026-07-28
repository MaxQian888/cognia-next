"use client"

import { useTranslations } from "next-intl"
import {
  AlertTriangleIcon,
  CircleAlert,
  Clock,
  Database,
  Gauge,
  KeyRound,
  Plug,
  ServerCrash,
  SettingsIcon,
  WifiOff,
  XIcon,
  type LucideIcon,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { ErrorParsedView } from "@/components/error/error-parsed-view"
import { DiagnosticActions, type DiagnosticActionHandlers } from "./diagnostic-actions"
import { specForCode } from "@cognia/diagnostics"
import type { CogniaDiagnostic, DiagnosticIcon, DiagnosticSeverity } from "@cognia/diagnostics"
import { cn } from "@/lib/utils"

/**
 * The shared inline failure card.
 *
 * Was `components/chat/inline-error.tsx`, used in exactly one place — the main
 * chat view — while agent-team runs, external-agent panes, workflow runs and
 * settings all fell back to raw toasts or bare text. Moving it here and driving
 * it from a {@link CogniaDiagnostic} rather than a string is what makes it
 * reusable: the caller no longer decides which category an error is or which
 * buttons it warrants, because the diagnostic already says.
 *
 * Notably gone: the `/api[\s_-]?key/i` regex that used to decide whether to
 * offer "Open settings". That test only ever fired for English provider
 * messages, so the affordance silently never appeared for anyone else. It now
 * comes from `DIAGNOSTIC_CODES[code].actions`.
 */

/** Icon tokens stay in the package (which must not import lucide); resolved here. */
const ICONS: Record<DiagnosticIcon, LucideIcon> = {
  network: WifiOff,
  clock: Clock,
  key: KeyRound,
  gauge: Gauge,
  server: ServerCrash,
  plug: Plug,
  settings: SettingsIcon,
  database: Database,
  alert: CircleAlert,
}

/** Hard failures read as destructive; anything the user can work around, as a warning. */
const DESTRUCTIVE: ReadonlySet<DiagnosticSeverity> = new Set<DiagnosticSeverity>(["fatal", "error"])

export interface DiagnosticCardProps {
  diagnostic: CogniaDiagnostic
  handlers?: DiagnosticActionHandlers
  /** Extra advice keys under `diagnostics.recoveryHint.*` (external agents). */
  recoveryHintKeys?: readonly string[]
  onDismiss?: () => void
  className?: string
}

export function DiagnosticCard({
  diagnostic,
  handlers = {},
  recoveryHintKeys,
  onDismiss,
  className,
}: DiagnosticCardProps) {
  const t = useTranslations("diagnostics")
  const spec = specForCode(diagnostic.code)
  const Icon = ICONS[spec.icon]
  const destructive = DESTRUCTIVE.has(diagnostic.severity)

  const labelKey = `code.${diagnostic.code}.label`
  const hintKey = `code.${diagnostic.code}.hint`
  // Falling back to the raw code keeps a diagnostic from a newer producer
  // readable rather than blank — the same degradation the reason-code badge uses.
  const label = t.has(labelKey) ? t(labelKey) : diagnostic.code
  const hint = t.has(hintKey) ? t(hintKey) : ""

  const hints = (recoveryHintKeys ?? []).map((id) =>
    t.has(`recoveryHint.${id}`) ? t(`recoveryHint.${id}`) : id
  )

  const runnable = diagnostic.actions.filter((action) => handlers[action.kind])
  const hasFooter = runnable.length > 0 || Boolean(onDismiss)

  return (
    <div
      role="alert"
      data-testid="diagnostic-card"
      data-code={diagnostic.code}
      data-severity={diagnostic.severity}
      className={cn(
        "overflow-hidden rounded-xl border shadow-sm",
        destructive
          ? "border-destructive/30 bg-destructive/[0.06]"
          : "border-warning/30 bg-warning/[0.06]",
        className
      )}
    >
      <div className="flex gap-3 p-3">
        <div
          className={cn(
            "flex size-8 shrink-0 items-center justify-center rounded-lg",
            destructive ? "bg-destructive/15 text-destructive" : "bg-warning/15 text-warning"
          )}
        >
          <Icon className="size-4" aria-hidden />
        </div>
        <div className="min-w-0 flex-1 space-y-1.5">
          <p
            className={cn("text-sm font-medium", destructive ? "text-destructive" : "text-warning")}
          >
            {label}
          </p>
          {hint && <p className="text-xs leading-relaxed text-foreground/80">{hint}</p>}
          {hints.length > 0 && (
            <ul className="list-disc space-y-0.5 ps-4 text-xs text-muted-foreground">
              {hints.map((text, i) => (
                <li key={i}>{text}</li>
              ))}
            </ul>
          )}
          {/* The raw provider/transport text, with its stack frames still clickable. */}
          {diagnostic.message && (
            <div className="text-xs leading-relaxed text-muted-foreground">
              <ErrorParsedView rawError={diagnostic.message} fallback={diagnostic.message} />
            </div>
          )}
        </div>
      </div>

      {hasFooter && (
        <div
          className={cn(
            "flex flex-wrap items-center gap-2 border-t px-3 py-2",
            destructive
              ? "border-destructive/15 bg-destructive/[0.03]"
              : "border-warning/15 bg-warning/[0.03]"
          )}
        >
          <DiagnosticActions actions={diagnostic.actions} handlers={handlers} />
          {onDismiss && (
            <Button
              variant="ghost"
              size="sm"
              className="ms-auto h-7 gap-1.5 text-muted-foreground hover:text-foreground"
              onClick={onDismiss}
              data-testid="diagnostic-card-dismiss"
            >
              <XIcon className="size-3.5" aria-hidden />
              {t("action.dismiss")}
            </Button>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * Back-compat shim for callers that still hold a bare string.
 *
 * Deliberately minimal and deprecated: every producer is being migrated to emit
 * a diagnostic, and this goes away with the last one. It keeps the original
 * `chat.inlineError.*` keys so no in-flight caller loses its labels mid-migration.
 */
export interface InlineErrorProps {
  message: string
  onRetry?: () => void | Promise<void>
  onOpenSettings?: () => void
  onDismiss?: () => void
}

/** @deprecated Emit a `CogniaDiagnostic` and render {@link DiagnosticCard} instead. */
export function InlineError({ message, onRetry, onOpenSettings, onDismiss }: InlineErrorProps) {
  const t = useTranslations("chat.inlineError")
  const hasActions = Boolean(onRetry) || Boolean(onOpenSettings) || Boolean(onDismiss)

  return (
    <div
      role="alert"
      data-testid="inline-error"
      className="mx-4 mt-2 overflow-hidden rounded-xl border border-destructive/30 bg-destructive/[0.06] shadow-sm"
    >
      <div className="flex gap-3 p-3">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-destructive/15 text-destructive">
          <AlertTriangleIcon className="size-4" aria-hidden />
        </div>
        <div className="min-w-0 flex-1 space-y-1.5">
          <p className="text-sm font-medium text-destructive">{t("title")}</p>
          <div className="text-xs leading-relaxed text-foreground/80">
            <ErrorParsedView rawError={message} fallback={message} />
          </div>
        </div>
      </div>
      {hasActions && (
        <div className="flex flex-wrap items-center gap-2 border-t border-destructive/15 bg-destructive/[0.03] px-3 py-2">
          {onRetry && (
            <Button variant="outline" size="sm" className="h-7" onClick={() => void onRetry()}>
              {t("retry")}
            </Button>
          )}
          {onOpenSettings && (
            <Button variant="ghost" size="sm" className="h-7" onClick={onOpenSettings}>
              {t("openSettings")}
            </Button>
          )}
          {onDismiss && (
            <Button
              variant="ghost"
              size="sm"
              className="ms-auto h-7 text-muted-foreground hover:text-foreground"
              onClick={onDismiss}
            >
              {t("dismiss")}
            </Button>
          )}
        </div>
      )}
    </div>
  )
}
