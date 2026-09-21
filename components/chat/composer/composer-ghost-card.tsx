"use client"

/**
 * The floating suggestion card — the completion surface that replaced the
 * inline ghost text. Painted above the composer box (`bottom-full`), it shows
 * the active candidate's suffix in NORMAL text colour (legibility was the
 * reason the dim inline ghost lost), with:
 *
 *   - a header: source pill, live status (thinking → suggesting), and one
 *     clickable dot per ranked candidate;
 *   - a body: the suffix, streamed in token by token with a block caret at the
 *     live edge — or a skeleton while the model is still thinking;
 *   - a footer: the keyboard hints as REAL buttons (tappable on touch, where
 *     Tab/⌥/Esc do not exist), plus a retry affordance when the last model
 *     round failed.
 *
 * The inline layer underneath keeps only a pulse caret marking where the
 * suggestion anchors — see `composer-ghost-text.tsx`.
 */

import { AnimatePresence, motion } from "motion/react"
import { AlertCircleIcon, RotateCcwIcon } from "lucide-react"
import { useTranslations } from "next-intl"

import { cn } from "@/lib/utils"
import { Kbd } from "@/components/ui/kbd"
import type { InlineSuggestion } from "@/lib/chat/completion/inline/types"

export interface ComposerGhostCardProps {
  /** Card visibility — a candidate exists, a query is in flight, or the last round failed. */
  open: boolean
  /** A model-tier call is in flight but nothing has streamed yet (TTFT gap). */
  querying: boolean
  /** The active candidate is still receiving tokens. */
  streaming: boolean
  /** The last model round failed or timed out — offer retry. */
  error: boolean
  /** The active candidate's suffix (what the card body paints). */
  ghost: string
  /** The active suggestion — source label + description come from it. */
  suggestion: InlineSuggestion | null
  /** All ranked candidates, for the dot strip. */
  candidates: readonly InlineSuggestion[]
  /** Index of the active candidate. */
  index: number
  /** Touch devices get labelled buttons instead of key hints. */
  isMobile: boolean
  onAccept: () => void
  onDismiss: () => void
  onCycleTo: (index: number) => void
  onRetry: () => void
}

const FOOTER_BUTTON =
  "flex items-center gap-1 rounded-md px-1.5 py-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"

export function ComposerGhostCard({
  open,
  querying,
  streaming,
  error,
  ghost,
  suggestion,
  candidates,
  index,
  isMobile,
  onAccept,
  onDismiss,
  onCycleTo,
  onRetry,
}: ComposerGhostCardProps) {
  const t = useTranslations("chat.composer")

  const sourceLabel = (() => {
    switch (suggestion?.source) {
      case "history":
        return t("ghostSourceHistory")
      case "command":
        return t("ghostSourceCommand")
      case "ai":
        return t("ghostSourceAi")
      case "agent":
        return t("ghostSourceAgent")
      // Unreachable today — no plugin registers an inline provider — kept so
      // the branch is ready when that surface lands (see composer.tsx history).
      case "plugin":
        return t("ghostSourcePlugin")
      default:
        return undefined
    }
  })()

  const status = error
    ? t("ghostCardFailed")
    : streaming
      ? t("ghostCardSuggesting")
      : querying
        ? t("ghostCardThinking")
        : t("ghostCardSuggestion")

  return (
    <AnimatePresence>
      {open ? (
        <motion.div
          key="composer-ghost-card"
          role="group"
          aria-label={t("ghostCardAriaLabel")}
          initial={{ opacity: 0, y: 6, scale: 0.985 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 4, scale: 0.99 }}
          transition={{ duration: 0.16, ease: "easeOut" }}
          className="absolute inset-x-0 bottom-full z-20 mb-2 overflow-hidden rounded-xl border border-border/60 bg-popover/95 shadow-lg backdrop-blur-sm"
          data-testid="composer-ghost-card"
        >
          <div className="flex items-center gap-2 border-b border-border/50 px-3 py-1.5 text-[11px] text-muted-foreground">
            {sourceLabel ? (
              <span
                className={cn(
                  "rounded-full bg-primary/10 px-1.5 py-px text-primary",
                  streaming && "animate-pulse"
                )}
                data-testid="composer-ghost-card-source"
              >
                {sourceLabel}
              </span>
            ) : null}
            <span className="min-w-0 flex-1 truncate">{status}</span>
            {candidates.length > 1 ? (
              <span className="flex items-center gap-1">
                {candidates.map((c, i) => (
                  <button
                    key={c.id ?? c.text}
                    type="button"
                    aria-label={t("ghostCardCandidate", { index: i + 1 })}
                    aria-pressed={i === index}
                    onClick={() => onCycleTo(i)}
                    className="flex size-4 items-center justify-center rounded-full"
                    data-testid={`composer-ghost-card-dot-${i}`}
                  >
                    <span
                      className={cn(
                        "size-1.5 rounded-full transition-colors",
                        i === index
                          ? "bg-primary"
                          : "bg-muted-foreground/30 hover:bg-muted-foreground/60"
                      )}
                    />
                  </button>
                ))}
              </span>
            ) : null}
          </div>

          <div className="min-h-[2.25rem] px-3 py-2 text-sm leading-6">
            {ghost ? (
              <>
                {ghost}
                {streaming ? (
                  <span
                    aria-hidden
                    className="ms-px inline-block h-[1em] w-[7px] translate-y-[0.15em] animate-pulse rounded-[1px] bg-primary/70"
                  />
                ) : null}
              </>
            ) : error ? (
              <span
                className="flex items-center gap-1.5 text-muted-foreground"
                data-testid="composer-ghost-card-error"
              >
                <AlertCircleIcon className="size-3.5" aria-hidden />
                {t("ghostCardFailed")}
              </span>
            ) : (
              <span aria-hidden className="inline-block h-4 w-2/3 animate-pulse rounded bg-muted" />
            )}
          </div>

          <div className="flex items-center gap-1 border-t border-border/50 px-3 py-1.5 text-[11px]">
            {error ? (
              <button
                type="button"
                className={FOOTER_BUTTON}
                onClick={onRetry}
                data-testid="composer-ghost-card-retry"
              >
                <RotateCcwIcon className="size-3" aria-hidden />
                {t("ghostCardRetry")}
              </button>
            ) : null}
            {ghost ? (
              <button type="button" className={FOOTER_BUTTON} onClick={onAccept}>
                {/* i18n-exempt: keyboard key legend */}
                {!isMobile ? <Kbd className="h-4 text-[10px]">Tab</Kbd> : null}
                {t("ghostAccept")}
              </button>
            ) : null}
            <button type="button" className={FOOTER_BUTTON} onClick={onDismiss}>
              {/* i18n-exempt: keyboard key legend */}
              {!isMobile ? <Kbd className="h-4 text-[10px]">Esc</Kbd> : null}
              {t("ghostDismiss")}
            </button>
            {!isMobile && candidates.length > 1 ? (
              <span className="ms-auto flex items-center gap-1 text-muted-foreground">
                <Kbd className="h-4 text-[10px]">⌥]</Kbd>
                <Kbd className="h-4 text-[10px]">⌥[</Kbd>
                {t("ghostCardCycle")}
              </span>
            ) : null}
          </div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  )
}
