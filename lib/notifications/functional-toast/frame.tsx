"use client"

/**
 * The shared functional-toast chrome — one frame, many card types. A
 * `FunctionalToastSpec` supplies everything the frame draws: identity plate,
 * eyebrow status line, optional tray, title, the kind-specific body slot,
 * footnote, ≤3 quiet actions and the accent strip. Layout, tones, spacing and
 * the toast's 356px width (sonner's native width, so it stacks flush with the
 * generic toasts) live here and nowhere else.
 *
 * Copy arrives already localized inside the spec; the only string the frame
 * owns is the dismiss button's aria-label, passed in by the host.
 */

import { XIcon } from "lucide-react"

import { cn } from "@/lib/utils"

import type { FunctionalToastActionSpec, FunctionalToastSpec, FunctionalToastTone } from "./types"

const TONE: Record<FunctionalToastTone, { text: string; dot: string }> = {
  live: {
    text: "text-emerald-600 dark:text-emerald-400",
    dot: "bg-emerald-500",
  },
  ok: {
    text: "text-emerald-600 dark:text-emerald-400",
    dot: "bg-emerald-500",
  },
  warn: {
    text: "text-amber-600 dark:text-amber-400",
    dot: "bg-amber-500",
  },
  danger: {
    text: "text-red-600 dark:text-red-400",
    dot: "bg-red-500",
  },
  muted: {
    text: "text-muted-foreground",
    dot: "bg-muted-foreground/50",
  },
}

export function FunctionalToast({
  spec,
  onAction,
  onDismiss,
  dismissLabel,
}: {
  spec: FunctionalToastSpec
  onAction: (action: FunctionalToastActionSpec) => void
  onDismiss: () => void
  dismissLabel: string
}) {
  const tone = TONE[spec.eyebrow.tone]
  return (
    <div
      className="w-[356px] overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-lg"
      data-testid="functional-toast"
    >
      <div className="px-3.5 pt-3">
        <div className="flex items-start gap-2.5">
          {spec.icon}
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-2">
              <span
                className={cn(
                  "flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.1em]",
                  tone.text
                )}
              >
                {spec.eyebrow.pulse ? (
                  <span className="relative flex size-1.5">
                    <span
                      className={cn(
                        "absolute inline-flex size-full animate-ping rounded-full opacity-60",
                        tone.dot
                      )}
                    />
                    <span className={cn("relative inline-flex size-1.5 rounded-full", tone.dot)} />
                  </span>
                ) : (
                  <span className={cn("size-1.5 rounded-full", tone.dot)} />
                )}
                {spec.eyebrow.text}
              </span>
              {spec.tray}
            </div>
            <p className="mt-1 truncate text-[13.5px] font-semibold leading-tight">{spec.title}</p>
          </div>
          <button
            type="button"
            aria-label={dismissLabel}
            onClick={onDismiss}
            className="-mr-1 -mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-md text-muted-foreground/70 transition-colors hover:bg-muted hover:text-foreground"
          >
            <XIcon className="size-3.5" />
          </button>
        </div>
        {spec.body}
      </div>
      {spec.footnote || (spec.actions && spec.actions.length > 0) ? (
        <div className="flex items-center justify-between gap-2 px-3.5 py-2">
          <span className="min-w-0 truncate text-[10.5px] text-muted-foreground">
            {spec.footnote}
          </span>
          {spec.actions && spec.actions.length > 0 && (
            <div className="flex shrink-0 items-center gap-3 text-[11px] font-medium">
              {spec.actions.slice(0, 3).map((a) => {
                const Icon = a.icon
                return (
                  <button
                    key={a.id}
                    type="button"
                    data-testid={`functional-toast-action-${a.id}`}
                    onClick={() => onAction(a)}
                    className={cn(
                      "flex items-center gap-1 transition-colors",
                      a.tone === "danger"
                        ? "text-red-600 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300"
                        : a.strong
                          ? "text-foreground underline-offset-2 hover:underline"
                          : "text-muted-foreground hover:text-foreground"
                    )}
                  >
                    {Icon ? <Icon className="size-3" /> : null}
                    {a.label}
                  </button>
                )
              })}
            </div>
          )}
        </div>
      ) : null}
      {spec.accentClass ? (
        <div className={cn("h-[3px] w-full", spec.accentClass)} aria-hidden="true" />
      ) : null}
    </div>
  )
}
