// The floating pet widget. Anchored to a corner, draggable, minimizable; shows
// the live pet (animated by the visual-state machine), its current bubble, and —
// when expanded — the interaction panel. Pure presentation over the hooks; gating
// + settings come from PetMount.

"use client"

import { useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { useReducedMotion } from "motion/react"
import { useTranslations } from "next-intl"
import { MinusIcon, PawPrintIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { isTauri } from "@/lib/platform/detect"
import { usePet } from "@/hooks/pet/use-pet"
import { usePetAnimationState } from "@/hooks/pet/use-pet-animation-state"
import { usePetBubbles } from "@/hooks/pet/use-pet-bubbles"
import { usePetSpeak } from "@/hooks/pet/use-pet-speak"
import { usePetProactive } from "@/hooks/pet/use-pet-proactive"
import { usePetInsight } from "@/hooks/pet/use-pet-insight"
import { usePetScheduledReminder } from "@/hooks/pet/use-pet-scheduled-reminder"
import { useActiveLive2dModel } from "@/hooks/pet/use-active-live2d-model"
import { useActiveSpritePack } from "@/hooks/pet/use-active-sprite-pack"
import { useDocumentHidden } from "@/hooks/pet/use-document-visible"
import { usePetDragGesture } from "@/hooks/pet/use-pet-drag-gesture"
import { usePetWidgetThrow } from "@/hooks/pet/use-pet-widget-throw"
import { usePetStore } from "@/stores/pet/pet-store"
import { isPetWindowOpen } from "@/lib/tauri/pet-window"
import { MIN_THROW_SPEED } from "@/lib/pet/overlay-geometry"
import { reactionForZone, resolveHitZone } from "@/lib/pet/interaction/hit-zones"
import { toggleDesktopPetWindow } from "@/lib/pet/commands"
import type { PetAnchor, PetSettings } from "@/types/pet"
import { withCareCondition } from "@/lib/pet/state/reducer"
import { resolveEffectiveSkin } from "./skins/resolve-effective-skin"
import { LIVE2D_ONE_SHOT_HOLD_MS } from "@/lib/pet/live2d/constants"
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

  const { profile, view, feed, play, petStroke, talk, sleep, clean, treat } =
    usePet(activeCharacterId)
  // Resolve which skin actually renders — live2d only when picked, the Cubism
  // runtime is ready, and an active model exists; otherwise the SVG mascot.
  // Resolved BEFORE the animation state so the one-shot queue can hold shots
  // long enough for Cubism motions to finish.
  const { modelId, coreReady } = useActiveLive2dModel(settings)
  const { row: activeSpritePack } = useActiveSpritePack(settings)
  const effectiveSkin = resolveEffectiveSkin(settings.skinId, {
    coreReady,
    hasActiveModel: Boolean(modelId),
    hasActiveSpritePack: Boolean(activeSpritePack),
  })
  const { state, oneShot } = usePetAnimationState(
    reduced,
    effectiveSkin === "live2d" ? { holdFloorMs: LIVE2D_ONE_SHOT_HOLD_MS } : {}
  )
  usePetBubbles(settings.enabled && !settings.mutedBubbles, view?.effectiveStats.snark ?? 0)
  // Owns every `talked` bubble (LLM side channel + template fallback). Main
  // window only — overlay talk replays here through the cross-window bridge.
  usePetSpeak({
    profile,
    view,
    enabled: settings.enabled && !settings.mutedBubbles,
    activeCharacterId,
  })
  // Proactive speech (opt-in): event comments / idle chatter / time greetings.
  usePetProactive({ profile, view, enabled: settings.enabled && !settings.mutedBubbles })
  // Attention Radar teaser: nudge when a fresh info-diet report lands.
  usePetInsight(settings.enabled && !settings.mutedBubbles)
  // Scheduled-task reminders: flourish + Notification-Center alert when a task
  // is due. Gated only on `enabled` — a reminder is real, not idle chatter.
  usePetScheduledReminder(settings.enabled)

  const bubble = usePetStore((s) => s.bubble)
  const minimized = usePetStore((s) => s.minimized)
  const setMinimized = usePetStore((s) => s.setMinimized)
  const [open, setOpen] = useState(false)
  // Stop the looping animations (framer-motion + pixi ticker) while the app
  // window is hidden/minimized — the pet still renders its resting frame.
  const docHidden = useDocumentHidden()

  // Drag/throw physics — the browser counterpart to the Tauri overlay's OS-
  // window throw (`use-pet-locomotion`'s beginThrow), so a flick feels the
  // same on both surfaces. `anchorRef` targets the outer, never-transformed
  // container below; only the handle button itself is offset, so its rect
  // stays a stable reference for the on-screen bounds.
  const anchorRef = useRef<HTMLDivElement | null>(null)
  const dragStartOffsetRef = useRef({ x: 0, y: 0 })
  const [holding, setHolding] = useState(false)
  const throwPhysics = usePetWidgetThrow({
    anchorRef,
    petSize: settings.size,
    initialOffset: usePetStore.getState().position,
    onSettle: (x, y) => {
      usePetStore.getState().setPosition({ x, y })
      // A throw settling plays the impact squash + dust (same as the overlay).
      usePetStore.getState().enqueueOneShot("land")
    },
  })
  const dragGesture = usePetDragGesture({
    onDragStart: () => {
      dragStartOffsetRef.current = throwPhysics.offset
      setHolding(true)
    },
    onDragMove: (dx, dy) => {
      const base = dragStartOffsetRef.current
      throwPhysics.setOffsetImmediate(base.x + dx, base.y + dy)
    },
    onRelease: ({ wasDrag, dx, dy, vx, vy, event }) => {
      setHolding(false)
      if (wasDrag) {
        const base = dragStartOffsetRef.current
        const x = base.x + dx
        const y = base.y + dy
        throwPhysics.setOffsetImmediate(x, y)
        if (!reduced && Math.hypot(vx, vy) >= MIN_THROW_SPEED) {
          // A flick → ballistic fall; the landing persists the position.
          throwPhysics.beginThrow(vx, vy)
        } else {
          usePetStore.getState().setPosition({ x, y })
        }
        return
      }
      // A non-drag tap resolves the touched body zone → a zone-specific local
      // flourish (mirrors the overlay's hit-zones) and opens the panel, but
      // grants no XP — that stays on the panel's explicit "Pet" button.
      const rect = (event.currentTarget as Element).getBoundingClientRect()
      const localX = event.clientX - rect.left
      const localY = event.clientY - rect.top
      const zone = resolveHitZone(localX, localY, rect.width || settings.size, "right")
      usePetStore.getState().enqueueOneShot(reactionForZone(zone))
      setOpen((o) => !o)
    },
    onCancel: () => setHolding(false),
  })

  // Quick-menu wiring. Navigation reuses the app router (settings live at
  // `/settings?section=pet`, the pet console at `/pet`). Desktop-pet toggling is
  // gated on Tauri; we refresh the live open-state every time the menu opens so
  // the toggle label is correct. The toggle itself (flip the OS window + persist
  // `desktopPet.enabled`) is shared with the `pet.toggle-window` command so a
  // global hotkey does exactly the same thing this menu item does.
  const router = useRouter()
  const showDesktopPetItems = isTauri()
  const [desktopPetOpen, setDesktopPetOpen] = useState(false)

  const handleToggleDesktopPet = () => {
    void toggleDesktopPetWindow().then(setDesktopPetOpen)
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
      ref={anchorRef}
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
            onSleep={sleep}
            onClean={clean}
            onTreat={treat}
            skinId={effectiveSkin}
            onOpenConsole={(tab) => router.push(`/pet?tab=${tab}`)}
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
          <button
            type="button"
            data-testid="pet-handle"
            onPointerDown={dragGesture.onPointerDown}
            onPointerMove={dragGesture.onPointerMove}
            onPointerUp={dragGesture.onPointerUp}
            onPointerCancel={dragGesture.onPointerCancel}
            onClick={(e) => {
              // A real pointer click is already handled by the tap branch of
              // onRelease above; only a keyboard activation (Enter/Space),
              // which the spec reports with detail===0, reaches here.
              if (e.detail === 0) setOpen((o) => !o)
            }}
            aria-label={t("widget.toggle")}
            className="cursor-grab touch-none active:cursor-grabbing"
            style={{
              transform: `translate3d(${throwPhysics.offset.x}px, ${throwPhysics.offset.y}px, 0)`,
            }}
          >
            <PetRenderer
              bones={view.effectiveBones}
              stage={profile.stage}
              // Honor the lazily-decayed care condition immediately: an idle pet
              // reads as `unwell` from elapsed time without waiting for the next
              // heartbeat/event to settle the store visual state.
              state={withCareCondition(state, view.condition)}
              flavor={profile.evolutionFlavor}
              oneShot={oneShot}
              reducedMotion={reduced}
              size={settings.size}
              skinId={effectiveSkin}
              mood={view.mood}
              speaking={Boolean(bubble)}
              held={holding}
              paused={docHidden}
            />
          </button>
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
