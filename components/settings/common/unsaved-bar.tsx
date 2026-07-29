"use client"

/**
 * The save affordance for settings panels that edit a draft.
 *
 * Before this, every form in the section rolled its own `dirty` boolean and
 * parked a permanent Save button at the bottom, which meant a panel always
 * looked like it had something to do. This bar is absent until there is
 * actually something to save, names how many fields changed, and offers the
 * discard that the per-form buttons never did.
 *
 * Presentational on purpose: the caller owns `status`, including the timer that
 * takes it from `saved` back to `clean`. That keeps the success confirmation
 * out of this component's state and makes every branch trivially renderable in
 * a test.
 */

import { useTranslations } from "next-intl"
import { AnimatePresence, motion } from "motion/react"
import { CheckIcon, Loader2Icon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { useFlowMotion } from "@/components/chat/motion/motion-reveal"
import { MOBILE_DURATION, MOBILE_EASE, MOBILE_SPRING } from "@/lib/ui/motion"

export type UnsavedBarStatus = "clean" | "dirty" | "saving" | "saved"

export interface UnsavedBarProps {
  status: UnsavedBarStatus
  /** How many fields differ from the baseline. */
  count: number
  onSave: () => void
  onDiscard: () => void
  className?: string
}

export function UnsavedBar({ status, count, onSave, onDiscard, className }: UnsavedBarProps) {
  const t = useTranslations("settings.common.unsavedBar")
  const { reduce, durationScale } = useFlowMotion()

  const visible = status !== "clean"

  const body = (
    <div
      className={cn(
        "flex items-center gap-3 rounded-lg border bg-background/95 px-3 py-2 shadow-lg backdrop-blur",
        className
      )}
      data-testid="unsaved-bar"
      data-status={status}
      role="status"
    >
      {status === "saved" ? (
        <span className="flex items-center gap-1.5 text-xs font-medium text-foreground">
          <motion.span
            initial={reduce ? false : { scale: 0.6, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={reduce ? { duration: 0 } : MOBILE_SPRING}
            className="flex size-4 items-center justify-center rounded-full bg-primary text-primary-foreground"
          >
            <CheckIcon className="size-3" />
          </motion.span>
          {t("saved")}
        </span>
      ) : (
        <>
          <span className="flex min-w-0 flex-1 items-center gap-1.5 text-xs text-muted-foreground">
            <span className="size-1.5 shrink-0 rounded-full bg-primary" aria-hidden />
            <span className="truncate">{t("unsavedCount", { count })}</span>
          </span>
          <Button
            variant="ghost"
            size="sm"
            className="h-7"
            onClick={onDiscard}
            disabled={status === "saving"}
            data-testid="unsaved-bar-discard"
          >
            {t("discard")}
          </Button>
          <Button
            size="sm"
            className="h-7"
            onClick={onSave}
            disabled={status === "saving"}
            data-testid="unsaved-bar-save"
          >
            {status === "saving" ? (
              <>
                <Loader2Icon className="mr-1.5 size-3 animate-spin" />
                {t("saving")}
              </>
            ) : (
              t("save")
            )}
          </Button>
        </>
      )}
    </div>
  )

  if (reduce) {
    return visible ? body : null
  }

  return (
    <AnimatePresence initial={false}>
      {visible ? (
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 12 }}
          transition={{ duration: MOBILE_DURATION.fast * durationScale, ease: MOBILE_EASE }}
        >
          {body}
        </motion.div>
      ) : null}
    </AnimatePresence>
  )
}
