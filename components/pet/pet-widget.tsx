// The floating pet widget. Anchored to a corner, draggable, minimizable; shows
// the live pet (animated by the visual-state machine), its current bubble, and —
// when expanded — the interaction panel. Pure presentation over the hooks; gating
// + settings come from PetMount.

"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { motion, useReducedMotion } from "motion/react"
import { useTranslations } from "next-intl"
import { MinusIcon, PawPrintIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { isTauri } from "@/lib/platform/detect"
import { usePet } from "@/hooks/pet/use-pet"
import { usePetAnimationState } from "@/hooks/pet/use-pet-animation-state"
import { usePetBubbles } from "@/hooks/pet/use-pet-bubbles"
import { useActiveLive2dModel } from "@/hooks/pet/use-active-live2d-model"
import { useDocumentHidden } from "@/hooks/pet/use-document-visible"
import { usePetStore } from "@/stores/pet/pet-store"
import { useSettingsStore } from "@/stores/settings"
import { closePetWindow, isPetWindowOpen, openPetWindow } from "@/lib/tauri/pet-window"
import { overlayWindowSize } from "@/lib/pet/overlay-geometry"
import { DEFAULT_PET_DESKTOP_OVERLAY, type PetAnchor, type PetSettings } from "@/types/pet"
import { resolveEffectiveSkin } from "./skins/resolve-effective-skin"
import { PetRenderer } from "./pet-renderer"
import { PetBubbleView } from "./pet-bubble"
import { PetInteractionPanel } from "./pet-interaction-panel"
import { PetQuickMenu } from "./pet-quick-menu"

const ANCHOR_POSITION: Record<PetAnchor, string> = {
  "bottom-right": "bottom-4 right-4",
  "bottom-left": "bottom-4 left-4",
  "top-right": "top-4 right-4",
  "top-left": "top-4 left-4",
}

// Horizontal alignment for the expanded flex-column stack only — must not leak
// into the minimized circle button, where it would knock the icon off-center.
const ANCHOR_ALIGN: Record<PetAnchor, string> = {
  "bottom-right": "items-end",
  "bottom-left": "items-start",
  "top-right": "items-end",
  "top-left": "items-start",
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

  // Resolve which skin actually renders — live2d only when picked, the Cubism
  // runtime is ready, and an active model exists; otherwise the SVG mascot.
  const { modelId, coreReady } = useActiveLive2dModel(settings)
  const effectiveSkin = resolveEffectiveSkin(settings.skinId, {
    coreReady,
    hasActiveModel: Boolean(modelId),
  })

  const bubble = usePetStore((s) => s.bubble)
  const minimized = usePetStore((s) => s.minimized)
  const setMinimized = usePetStore((s) => s.setMinimized)
  const [open, setOpen] = useState(false)
  // Stop the looping animations (framer-motion + pixi ticker) while the app
  // window is hidden/minimized — the pet still renders its resting frame.
  const docHidden = useDocumentHidden()

  // Quick-menu wiring. Navigation reuses the app router (settings live at
  // `/settings?section=pet`, the pet console at `/pet`). Desktop-pet toggling is
  // gated on Tauri; we refresh the live open-state every time the menu opens so
  // the toggle label is correct, then flip both the OS window and the persisted
  // `desktopPet.enabled` flag.
  const router = useRouter()
  const save = useSettingsStore((s) => s.save)
  const showDesktopPetItems = isTauri()
  const [desktopPetOpen, setDesktopPetOpen] = useState(false)

  const handleToggleDesktopPet = () => {
    void (async () => {
      const desktop = settings.desktopPet ?? DEFAULT_PET_DESKTOP_OVERLAY
      if (desktopPetOpen) {
        await closePetWindow()
        await save({ petSettings: { ...settings, desktopPet: { ...desktop, enabled: false } } })
        setDesktopPetOpen(false)
        return
      }
      await openPetWindow({
        ...overlayWindowSize(desktop.size),
        x: desktop.position?.x,
        y: desktop.position?.y,
        clickThrough: desktop.clickThrough,
      })
      await save({ petSettings: { ...settings, desktopPet: { ...desktop, enabled: true } } })
      setDesktopPetOpen(true)
    })()
  }

  const handleMenuOpenChange = (next: boolean) => {
    if (next && showDesktopPetItems) {
      void isPetWindowOpen().then(setDesktopPetOpen)
    }
  }

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
          ANCHOR_POSITION[settings.anchor]
        )}
      >
        <PawPrintIcon className="size-5" />
      </button>
    )
  }

  return (
    <div
      className={cn(
        "fixed z-50 flex flex-col gap-2",
        ANCHOR_POSITION[settings.anchor],
        ANCHOR_ALIGN[settings.anchor]
      )}
    >
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
        <PetQuickMenu
          context="widget"
          actions={{
            onFeed: feed,
            onPlay: play,
            onPet: petStroke,
            onTalk: talk,
            onOpenConsole: () => router.push("/pet"),
            onToggleDesktopPet: handleToggleDesktopPet,
            onMinimize: () => setMinimized(true),
            onOpenSettings: () => router.push("/settings?section=pet"),
          }}
          desktopPetOpen={desktopPetOpen}
          showDesktopPetItems={showDesktopPetItems}
          onOpenChange={handleMenuOpenChange}
        >
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
              skinId={effectiveSkin}
              paused={docHidden}
            />
          </motion.button>
        </PetQuickMenu>
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
