"use client"

// Composer toolbar chip for the thinking level — the control's primary entry
// point, and the reason this feature stopped being invisible.
//
// It used to live only at the bottom of the model popover, on the argument that
// depth qualifies a model and so belongs with it. That made a per-turn decision
// cost two interactions and a scroll, and left the current tier unreadable
// without opening something — a user who never went looking had no way to learn
// the control existed at all.
//
// So the tier gets a chip on the permanent execution row, beside the model and
// permission chips that answer the same "what will this run as" question. This
// is now the ONLY surface for it: the model popover's copy and the `· low`
// qualifier on the model chip are gone, because three statements of one setting
// on one row read as three settings.
//
// Self-gates to nothing on a surface with no depth control (see
// `./effort-surface`), so a composer where it would be a no-op pays nothing for
// it — including the toolbar's chrome budget, which counts mounted controls.

import { useState } from "react"
import { useTranslations } from "next-intl"
import { BrainIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { ResponsivePicker } from "@/components/shared/responsive-picker"
import { cn } from "@/lib/utils"
import {
  clampThinkingLevel,
  isUltracodeLevel,
  resolveThinkingLevel,
  type ThinkingLevel,
} from "@/lib/ai/thinking-level"
import type { ChatSession } from "@cognia/agent-config-types"
import { EffortSelector } from "./effort-selector"
import { useEffortSurface } from "./effort-surface"

interface EffortChipProps {
  session: ChatSession | null
  /** Disable interaction while a turn is in flight. */
  disabled?: boolean
  className?: string
}

export function EffortChip({ session, disabled, className }: EffortChipProps) {
  const t = useTranslations("chat.composer.effort")
  const surface = useEffortSurface(session)
  const [open, setOpen] = useState(false)

  if (!session?.id) return null
  if (surface.levels.length === 0) return null

  // The same projection the card shows: a tier the active surface can't honour
  // displays as the deepest one it can, so the chip never advertises depth the
  // turn won't carry.
  const current: ThinkingLevel = clampThinkingLevel(resolveThinkingLevel(session), surface.levels)
  const ultra = isUltracodeLevel(current)

  return (
    <ResponsivePicker
      open={open}
      onOpenChange={setOpen}
      // A form, not an option list: the card is sliders and rows, and cmdk
      // would take its keystrokes.
      variant="panel"
      title={t("title")}
      align="start"
      side="top"
      // Width matches the model popover's, so opening one after the other
      // doesn't resize the surface under the pointer.
      contentClassName="w-[19rem]"
      testId="effort-panel"
      trigger={
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled}
          aria-label={t("triggerAria", { level: t(`level.${current}` as "level.off") })}
          data-testid="effort-chip"
          data-level={current}
          className={cn("gap-1", ultra && "text-effort-ultra hover:text-effort-ultra", className)}
        >
          {/* Both halves are keyed by tier so React remounts them and their
              entrance re-fires: this chip is often the only part of the control
              on screen when the level changes (a keyboard commit inside the
              popover, or a preset), and a silent relabel is easy to
              miss on a row this quiet. */}
          <BrainIcon
            key={`glyph-${current}`}
            className={cn(
              "effort-glyph-pulse size-3.5 shrink-0",
              ultra && "text-effort-ultra drop-shadow-[0_0_6px_var(--effort-ultra)]"
            )}
            aria-hidden
          />
          <span key={`label-${current}`} className="effort-value-rise truncate">
            {t(`level.${current}` as "level.off")}
          </span>
        </Button>
      }
    >
      <EffortSelector session={session} disabled={disabled} />
    </ResponsivePicker>
  )
}
