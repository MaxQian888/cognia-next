"use client"

/**
 * Renders a diagnostic's remediation actions as buttons.
 *
 * Pure and handler-driven: it knows how to *label* every action kind (from the
 * shared `diagnostics.action.*` keys) but nothing about how to perform one. The
 * call site supplies handlers for the kinds it can service, and any action
 * without a handler is dropped rather than rendered dead — a button that does
 * nothing is worse than no button.
 *
 * That split is what lets the same component serve the chat card, a settings
 * pane and the error page without any of them inheriting the others' routing.
 */

import { useTranslations } from "next-intl"
import { useEffect, useState, type ComponentProps } from "react"

import { Button } from "@/components/ui/button"
import { actionI18nKey } from "@cognia/diagnostics"
import type { DiagnosticAction, DiagnosticActionKind } from "@cognia/diagnostics"
import { cn } from "@/lib/utils"

export type DiagnosticActionHandlers = Partial<
  Record<DiagnosticActionKind, (action: DiagnosticAction) => void>
>

export interface DiagnosticActionsProps {
  actions: readonly DiagnosticAction[]
  handlers: DiagnosticActionHandlers
  /**
   * Cap on rendered buttons. A toast has room for two; an inline card can take
   * the full set. Excess is dropped from the end, so the registry's
   * most-useful-first ordering decides what survives.
   */
  max?: number
  size?: ComponentProps<typeof Button>["size"]
  className?: string
}

/**
 * `wait-and-retry` is a `retry` that carries the provider's `Retry-After`;
 * `createDiagnostic` substitutes one for the other whenever `meta.retryAfterMs`
 * is present, so no registry entry ever lists it and no call site expects to
 * register it. Any surface able to retry can service it — the payload only
 * changes the label — so it falls back to the `retry` handler rather than being
 * dropped as unhandled. Without this a rate-limited turn renders a card with no
 * buttons at all, because `rateLimited` offers exactly `retry` plus a fallback
 * provider and the substitution removes the only kind anyone registered.
 */
function resolveHandler(
  handlers: DiagnosticActionHandlers,
  kind: DiagnosticActionKind
): ((action: DiagnosticAction) => void) | undefined {
  return handlers[kind] ?? (kind === "wait-and-retry" ? handlers.retry : undefined)
}

/**
 * Ticks the provider's `Retry-After` down so the label is a countdown rather
 * than a number frozen at render time, then reverts to a plain "Retry" once the
 * wait is over. The button around it stays enabled the whole way: the window is
 * the provider's advice, and retrying early is the user's call.
 *
 * Its own component so `retryAfterMs` is a mount-time constant — that lets the
 * deadline come from a lazy initializer instead of a render-time `Date.now()`,
 * and keeps the timer out of the parent's render path. Callers key it on the
 * delay so a new `Retry-After` restarts the count.
 */
function WaitAndRetryLabel({ retryAfterMs }: { retryAfterMs: number }) {
  const t = useTranslations("diagnostics.action")
  const [deadline] = useState(() => Date.now() + retryAfterMs)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const id = setInterval(() => {
      const current = Date.now()
      setNow(current)
      if (current >= deadline) clearInterval(id)
    }, 1_000)
    return () => clearInterval(id)
  }, [deadline])

  const remaining = Math.max(0, Math.ceil((deadline - now) / 1_000))
  return <>{remaining > 0 ? t("waitAndRetry", { seconds: remaining }) : t("retry")}</>
}

export function DiagnosticActions({
  actions,
  handlers,
  max,
  size = "sm",
  className,
}: DiagnosticActionsProps) {
  const t = useTranslations("diagnostics.action")

  const runnable = actions.filter((action) => resolveHandler(handlers, action.kind))
  const shown = max === undefined ? runnable : runnable.slice(0, max)
  if (shown.length === 0) return null

  return (
    <div className={cn("flex flex-wrap items-center gap-2", className)}>
      {shown.map((action, index) => (
        <Button
          key={`${action.kind}-${index}`}
          type="button"
          // The registry orders actions most-useful-first, so position is the
          // single source of emphasis — no second variant table to drift.
          variant={index === 0 ? "outline" : "ghost"}
          size={size}
          className="h-7 gap-1.5"
          onClick={() => resolveHandler(handlers, action.kind)?.(action)}
          data-testid={`diagnostic-action-${action.kind}`}
        >
          {action.kind === "wait-and-retry" ? (
            <WaitAndRetryLabel key={action.retryAfterMs} retryAfterMs={action.retryAfterMs} />
          ) : (
            t(actionI18nKey(action.kind))
          )}
        </Button>
      ))}
    </div>
  )
}
