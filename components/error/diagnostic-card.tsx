"use client"

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import {
  AlertTriangleIcon,
  ChevronDown,
  ChevronRight,
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
import { resolvePreset } from "@cognia/error-parsers"
import type { ParsedError } from "@cognia/error-parsers/types"
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
  const tDetail = useTranslations("diagnostics.detail")
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

  // A producer whose raw text says nothing to a reader puts the translated
  // sentence in `message` and the host's own words in `detail` — so the two can
  // coincide with the code's hint. Printing the same sentence twice reads as a
  // rendering bug, so each is dropped when it only repeats what is already up.
  const rawMessage = diagnostic.message.trim()
  const message = rawMessage === hint.trim() ? "" : rawMessage
  const detail = diagnostic.detail?.trim() ?? ""
  const hasDetail = detail !== "" && detail !== rawMessage && detail !== hint.trim()

  // The raw provider/transport text is evidence for whoever is diagnosing, not
  // the headline: the label + hint already say what happened. It used to render
  // inline through the parser, which re-stated the card's own category as a
  // badge plus the same hint sentence ("Request timed out" twice) above the raw
  // line. Now it sits behind the one disclosure, verbatim and monospace. The
  // parsed view survives only where it adds something — a stack whose frames
  // open in the viewer, a JSON tree, a different category — and then without
  // the badge that duplicates this card's own code.
  const parsedMessage = useMemo<ParsedError | null>(() => {
    if (!message) return null
    const result = resolvePreset().parse(message)
    if (!result.parsed) return null
    const nodes = result.nodes.filter(
      (node) => !(node.kind === "category" && node.category === diagnostic.code)
    )
    return nodes.some((node) => node.kind !== "text") ? { nodes, parsed: true } : null
  }, [message, diagnostic.code])

  const hasTechnical = message !== "" || hasDetail
  // With no vocabulary entry for the code (or the catch-all `unknown`), the raw
  // text is the only thing that says what went wrong — start it open.
  const [showDetail, setShowDetail] = useState(() => !hint || diagnostic.code === "unknown")

  const runnable = diagnostic.actions.filter((action) => handlers[action.kind])
  const hasActionRow = hasTechnical || runnable.length > 0
  const tone = destructive ? "text-destructive" : "text-warning"

  return (
    <div
      role="alert"
      data-testid="diagnostic-card"
      data-code={diagnostic.code}
      data-severity={diagnostic.severity}
      className={cn(
        "rounded-lg border px-3 py-2",
        destructive
          ? "border-destructive/30 bg-destructive/[0.06]"
          : "border-warning/30 bg-warning/[0.06]",
        className
      )}
    >
      <div className="flex items-start gap-2">
        <Icon className={cn("mt-0.5 size-4 shrink-0", tone)} aria-hidden />
        <div className="min-w-0 flex-1">
          <p className={cn("text-sm leading-5 font-medium", tone)}>{label}</p>
          {hint && <p className="mt-0.5 text-xs leading-snug text-foreground/75">{hint}</p>}
          {hints.length > 0 && (
            <ul className="mt-1 list-disc space-y-0.5 ps-4 text-xs text-muted-foreground">
              {hints.map((text, i) => (
                <li key={i}>{text}</li>
              ))}
            </ul>
          )}
        </div>
        {onDismiss && (
          <Button
            variant="ghost"
            size="icon"
            className="-me-1.5 -mt-0.5 size-6 shrink-0 text-muted-foreground hover:text-foreground pointer-coarse:size-8"
            onClick={onDismiss}
            aria-label={t("action.dismiss")}
            title={t("action.dismiss")}
            data-testid="diagnostic-card-dismiss"
          >
            <XIcon className="size-3.5" aria-hidden />
          </Button>
        )}
      </div>

      {hasActionRow && (
        <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 ps-6">
          {hasTechnical && (
            <button
              type="button"
              onClick={() => setShowDetail((v) => !v)}
              className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
              data-testid="diagnostic-card-detail-toggle"
              aria-expanded={showDetail}
            >
              {showDetail ? (
                <ChevronDown className="size-3" aria-hidden />
              ) : (
                <ChevronRight className="size-3" aria-hidden />
              )}
              {showDetail ? tDetail("hideRaw") : tDetail("showRaw")}
            </button>
          )}
          <DiagnosticActions
            actions={diagnostic.actions}
            handlers={handlers}
            className="ms-auto gap-1.5"
          />
        </div>
      )}

      {hasTechnical && showDetail && (
        <div className="mt-1.5 ms-6 space-y-1.5" data-testid="diagnostic-card-technical">
          {message &&
            (parsedMessage ? (
              <div className="text-xs" data-testid="diagnostic-card-message">
                <ErrorParsedView parsed={parsedMessage} rawText={message} initialView="raw" />
              </div>
            ) : (
              <pre className={RAW_BLOCK} data-testid="diagnostic-card-message">
                {message}
              </pre>
            ))}
          {hasDetail && (
            <pre className={RAW_BLOCK} data-testid="diagnostic-card-detail">
              {detail}
            </pre>
          )}
        </div>
      )}
    </div>
  )
}

/** Verbatim technical text: small monospace, wrapped so a phone never scrolls it sideways. */
const RAW_BLOCK =
  "max-h-60 overflow-auto rounded bg-muted/40 px-2 py-1.5 font-mono text-[11px] leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere] text-foreground/80"

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
      className="rounded-lg border border-destructive/30 bg-destructive/[0.06] px-3 py-2"
    >
      <div className="flex items-start gap-2">
        <AlertTriangleIcon className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
        <div className="min-w-0 flex-1 space-y-0.5">
          <p className="text-sm leading-5 font-medium text-destructive">{t("title")}</p>
          <div className="text-xs leading-snug text-foreground/80">
            <ErrorParsedView rawError={message} fallback={message} />
          </div>
        </div>
      </div>
      {hasActions && (
        <div className="mt-1.5 flex flex-wrap items-center justify-end gap-1.5 ps-6">
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
              className="h-7 text-muted-foreground hover:text-foreground"
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
