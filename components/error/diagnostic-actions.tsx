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
import type { ComponentProps } from "react"

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

export function DiagnosticActions({
  actions,
  handlers,
  max,
  size = "sm",
  className,
}: DiagnosticActionsProps) {
  const t = useTranslations("diagnostics.action")

  const runnable = actions.filter((action) => handlers[action.kind])
  const shown = max === undefined ? runnable : runnable.slice(0, max)
  if (shown.length === 0) return null

  return (
    <div className={cn("flex flex-wrap items-center gap-2", className)}>
      {shown.map((action, index) => {
        const key = actionI18nKey(action.kind)
        return (
          <Button
            key={`${action.kind}-${index}`}
            type="button"
            // The registry orders actions most-useful-first, so position is the
            // single source of emphasis — no second variant table to drift.
            variant={index === 0 ? "outline" : "ghost"}
            size={size}
            className="h-7 gap-1.5"
            onClick={() => handlers[action.kind]?.(action)}
            data-testid={`diagnostic-action-${action.kind}`}
          >
            {action.kind === "wait-and-retry"
              ? t(key, { seconds: Math.ceil(action.retryAfterMs / 1000) })
              : t(key)}
          </Button>
        )
      })}
    </div>
  )
}
