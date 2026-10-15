"use client"

import { useId, type ReactNode } from "react"
import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { cn } from "@/lib/utils"

export interface AgentDetailStatusProps {
  tone: "ok" | "info" | "warning" | "error"
  title: string
  message?: string
  action?: {
    label: string
    onRun?: () => void
    href?: string
    busy?: boolean
    disabled?: boolean
    disabledReason?: string
  }
  actionContent?: ReactNode
  secondary?: { label: string; onRun: () => void }
  details?: ReactNode
  detailsLabel?: string
}

const TONE_CLASS = {
  ok: "bg-emerald-500/10",
  info: "bg-primary/5",
  warning: "bg-amber-500/10",
  error: "bg-destructive/10",
}

export function AgentDetailStatus({
  tone,
  title,
  message,
  action,
  actionContent,
  secondary,
  details,
  detailsLabel,
}: AgentDetailStatusProps) {
  const t = useTranslations("externalAgent.settings")
  const id = useId()
  const disabled = action?.disabled || action?.busy
  const reasonId = action?.disabledReason ? `${id}-reason` : undefined

  return (
    <section
      role={tone === "error" ? "alert" : "status"}
      aria-labelledby={`${id}-title`}
      className={cn("min-w-0 space-y-3 rounded-lg p-4 [overflow-wrap:anywhere]", TONE_CLASS[tone])}
      data-testid="agent-detail-status"
    >
      <div className="space-y-1">
        <p id={`${id}-title`} className="text-sm font-medium">
          {title}
        </p>
        {message ? <p className="text-sm text-muted-foreground">{message}</p> : null}
      </div>
      {actionContent ??
        (action ? (
          <div className="space-y-1">
            {action.href && !disabled ? (
              <Button
                asChild
                className="h-auto min-h-11 w-full whitespace-normal [overflow-wrap:anywhere]"
                aria-describedby={reasonId}
              >
                <a
                  href={action.href}
                  onClick={(event) => {
                    if (
                      !action.onRun ||
                      event.button !== 0 ||
                      event.ctrlKey ||
                      event.metaKey ||
                      event.shiftKey ||
                      event.altKey
                    )
                      return
                    event.preventDefault()
                    action.onRun()
                  }}
                >
                  {action.label}
                </a>
              </Button>
            ) : (
              <Button
                type="button"
                className="h-auto min-h-11 w-full whitespace-normal [overflow-wrap:anywhere]"
                onClick={action.onRun}
                disabled={disabled}
                aria-busy={action.busy || undefined}
                aria-describedby={reasonId}
              >
                {action.busy ? <Spinner /> : null}
                {action.label}
              </Button>
            )}
            {action.disabledReason ? (
              <p id={reasonId} className="text-xs text-muted-foreground">
                {action.disabledReason}
              </p>
            ) : null}
          </div>
        ) : null)}
      {secondary ? (
        <Button
          type="button"
          variant="link"
          className="h-auto whitespace-normal p-0 [overflow-wrap:anywhere]"
          onClick={secondary.onRun}
        >
          {secondary.label}
        </Button>
      ) : null}
      {details ? (
        <details className="text-sm">
          <summary className="cursor-pointer text-muted-foreground">
            {detailsLabel ?? t("mobileDetailShowDetails")}
          </summary>
          <div className="mt-3 space-y-2">{details}</div>
        </details>
      ) : null}
    </section>
  )
}
