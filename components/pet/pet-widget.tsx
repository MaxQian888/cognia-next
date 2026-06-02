// The floating pet widget. Anchored to a corner, draggable, minimizable; shows
// the live pet (animated by the visual-state machine), its current bubble, and —
// when expanded — the interaction panel. Pure presentation over the hooks; gating
// + settings come from PetMount.

"use client"

import { useState } from "react"
import { motion, useReducedMotion } from "motion/react"
import { useTranslations } from "next-intl"
import { MinusIcon, PawPrintIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { usePet } from "@/hooks/pet/use-pet"
import { usePetAnimationState } from "@/hooks/pet/use-pet-animation-state"
import { usePetBubbles } from "@/hooks/pet/use-pet-bubbles"
import { usePetStore } from "@/stores/pet/pet-store"
import type { PetAnchor, PetSettings } from "@/types/pet"
import { PetRenderer } from "./pet-renderer"
import { PetBubbleView } from "./pet-bubble"
import { PetInteractionPanel } from "./pet-interaction-panel"

const ANCHOR_CLASS: Record<PetAnchor, string> = {
  "bottom-right": "bottom-4 right-4 items-end",
  "bottom-left": "bottom-4 left-4 items-start",
  "top-right": "top-4 right-4 items-end",
  "top-left": "top-4 left-4 items-start",
}

export interface PetWidgetProps {
  settings: PetSettings
  activeCharacterId?: string | null
}

export function PetWidget({ settings, activeCharacterId }: PetWidgetProps) {
  const t = useTranslations("pet")
  const osReduced = useReducedMotion()
  const reduced =
    settings.motion === "reduced" || (settings.motion === "auto" && Boolean(osReduced))

  const { profile, view, feed, play, petStroke, talk } = usePet(activeCharacterId)
  const { state, oneShot } = usePetAnimationState(reduced)
  usePetBubbles(settings.enabled && !settings.mutedBubbles)

  const bubble = usePetStore((s) => s.bubble)
  const minimized = usePetStore((s) => s.minimized)
  const setMinimized = usePetStore((s) => s.setMinimized)
  const [open, setOpen] = useState(false)

  if (!profile || !view) return null

  if (minimized) {
    return (
      <button
        type="button"
        data-testid="pet-restore"
        onClick={() => setMinimized(false)}
        aria-label={t("widget.restore")}
        className={cn(
          "fixed z-50 flex size-10 items-center justify-center rounded-full border bg-card shadow-md",
          ANCHOR_CLASS[settings.anchor]
        )}
      >
        <PawPrintIcon className="size-5" />
      </button>
    )
  }

  return (
    <div className={cn("fixed z-50 flex flex-col gap-2", ANCHOR_CLASS[settings.anchor])}>
      {bubble && <PetBubbleView bubble={bubble} />}
      {open && (
        <div className="rounded-xl border bg-popover p-3 shadow-lg">
          <PetInteractionPanel
            profile={profile}
            view={view}
            onFeed={feed}
            onPlay={play}
            onPet={petStroke}
            onTalk={talk}
          />
        </div>
      )}
      <div className="flex items-end gap-1">
        <motion.button
          type="button"
          data-testid="pet-handle"
          drag
          dragMomentum={!reduced}
          onClick={() => setOpen((o) => !o)}
          aria-label={t("widget.toggle")}
          className="cursor-grab active:cursor-grabbing"
        >
          <PetRenderer
            bones={view.effectiveBones}
            stage={profile.stage}
            state={state}
            oneShot={oneShot}
            reducedMotion={reduced}
            size={settings.size}
          />
        </motion.button>
        <button
          type="button"
          onClick={() => setMinimized(true)}
          aria-label={t("widget.minimize")}
          className="rounded-full border bg-card p-1 text-muted-foreground shadow-sm hover:text-foreground"
        >
          <MinusIcon className="size-3.5" />
        </button>
      </div>
    </div>
  )
}
