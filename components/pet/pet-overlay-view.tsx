// The transparent desktop-pet overlay window's root view. Rendered by
// `app/pet-overlay/page.tsx` inside the frameless always-on-top "pet" Tauri
// window (window role "overlay"). It owns NO controller: the pet profile flows
// in via Dexie `useLiveQuery` (cross-window reactive), and the ephemeral visual
// state / one-shots / bubble arrive over the cross-window bridge. User
// interactions are posted back to the main window, which awards XP exactly once.
//
// Responsibilities:
//  - Make the window paint through to the desktop (`data-pet-overlay` on <html>).
//  - Render the pet (effective skin) + its speech bubble, centered.
//  - Drag the OS window with a small movement threshold (rAF-throttled), and
//    persist the resting position into PetSettings on pointer-up.
//  - Treat a non-drag click as a "pet" interaction (mirrors the widget delight).
//
// The right-click quick menu wraps the stable `data-testid="pet-overlay-root"`
// container; opening it grows the window for menu space and restores it on close.

"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { useReducedMotion } from "motion/react"
import { useTranslations } from "next-intl"
import { useSettingsStore } from "@/stores/settings"
import {
  DEFAULT_PET_DESKTOP_OVERLAY,
  DEFAULT_PET_SETTINGS,
  DEFAULT_PET_WANDER,
  type PetSettings,
} from "@/types/pet"
import { usePet } from "@/hooks/pet/use-pet"
import { usePetAnimationState } from "@/hooks/pet/use-pet-animation-state"
import { useActiveLive2dModel } from "@/hooks/pet/use-active-live2d-model"
import { useDocumentHidden } from "@/hooks/pet/use-document-visible"
import { usePetLocomotion } from "@/hooks/pet/use-pet-locomotion"
import { usePetDragGesture } from "@/hooks/pet/use-pet-drag-gesture"
import { usePetStore } from "@/stores/pet/pet-store"
import { startOverlayPetBridge } from "@/lib/pet/events/cross-window-bridge"
import { schedulePetWindowReveal } from "@/lib/pet/reveal"
import {
  getPetWindowPosition,
  getPetWorkArea,
  openPetPopup,
  setPetWindowPosition,
} from "@/lib/tauri/pet-window"
import { MIN_THROW_SPEED, overlayWindowSize } from "@/lib/pet/overlay-geometry"
import {
  POPUP_INITIAL_HEIGHT,
  POPUP_INITIAL_WIDTH,
  resolvePopupPlacement,
} from "@/lib/pet/popup-geometry"
import { reactionForZone, resolveHitZone } from "@/lib/pet/interaction/hit-zones"
import { withCareCondition } from "@/lib/pet/state/reducer"
import { resolveEffectiveSkin } from "./skins/resolve-effective-skin"
import { PetRenderer } from "./pet-renderer"
import { PetBubbleView } from "./pet-bubble"

export function PetOverlayView() {
  const t = useTranslations("pet.overlay")
  const settings = useSettingsStore((s) => s.settings)
  const save = useSettingsStore((s) => s.save)
  const pet: PetSettings = settings?.petSettings ?? DEFAULT_PET_SETTINGS
  const desktopPet = pet.desktopPet ?? DEFAULT_PET_DESKTOP_OVERLAY
  const size = desktopPet.size ?? DEFAULT_PET_DESKTOP_OVERLAY.size

  // Unified skin resolution — identical to the in-app widget: live2d renders
  // only when picked, the Cubism runtime is ready, and an active model exists;
  // otherwise the SVG mascot.
  const { modelId, coreReady } = useActiveLive2dModel(pet)
  const skinId = resolveEffectiveSkin(pet.skinId, {
    coreReady,
    hasActiveModel: Boolean(modelId),
  })

  const osReduced = useReducedMotion()
  const reduced = pet.motion === "reduced" || (pet.motion === "auto" && Boolean(osReduced))

  const { profile, view } = usePet(undefined)
  const { state, oneShot } = usePetAnimationState(reduced)
  const bubble = usePetStore((s) => s.bubble)
  const hidden = useDocumentHidden()
  const [dragging, setDragging] = useState(false)

  // Last user-interaction timestamp (perf clock — same one the locomotion io
  // uses) feeding the "only move after interaction" wander gate. Stamped by
  // the bridge `sendInteraction` wrapper below.
  const lastInteractionRef = useRef<number | null>(null)

  // Paint through to the desktop while this window is mounted.
  useEffect(() => {
    const root = document.documentElement
    root.dataset.petOverlay = "1"
    return () => {
      delete root.dataset.petOverlay
    }
  }, [])

  // Reveal the sprite window only AFTER the first painted frame. Rust creates
  // it `visible(false)` and no longer shows it on open — see
  // `lib/pet/reveal.ts` for the full Windows transparency rationale (shared
  // with the click popup). No focus: the sprite must never steal it.
  useEffect(() => schedulePetWindowReveal(), [])

  // Single cross-window bridge: subscribes the per-window store to inbound
  // messages (requesting the current snapshot on connect) and exposes
  // `sendInteraction` to the click handler + quick menu via a stable ref so the
  // pointer callbacks don't re-bind every render.
  const sendInteractionRef = useRef<
    (kind: "fed" | "played" | "petted" | "talked", text?: string) => void
  >(() => {})
  useEffect(() => {
    const bridge = startOverlayPetBridge({
      // Smart-Moving: main-window activity counts as "interaction" for the
      // wander gate. Stamp OUR clock — the gate runs on performance.now(),
      // not the epoch ms carried on the wire.
      onActivity: () => {
        lastInteractionRef.current = performance.now()
      },
    })
    sendInteractionRef.current = (kind, text) => {
      lastInteractionRef.current = performance.now()
      if (text === undefined) bridge.sendInteraction(kind)
      else bridge.sendInteraction(kind, text)
    }
    return () => {
      sendInteractionRef.current = () => {}
      bridge.dispose()
    }
  }, [])

  // Right-click opens the click popup in its own "pet-popup" window (the menu +
  // interaction panel + talk composer live there now). The sprite window no
  // longer resizes or shifts for a menu — it stays put, killing the old
  // resize/reposition races. Placement is resolved from the sprite window's
  // physical rect + the monitor work area, then the popup opens already clamped
  // on-screen. Left-click (pet/drag) and the bubble are untouched.
  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault()
    void (async () => {
      const [pos, workArea] = await Promise.all([getPetWindowPosition(), getPetWorkArea()])
      if (!pos || !workArea) return
      const logical = overlayWindowSize(size)
      const sprite = {
        x: pos.x,
        y: pos.y,
        width: logical.width * scaleFactor,
        height: logical.height * scaleFactor,
      }
      const popupSizePhys = {
        width: POPUP_INITIAL_WIDTH * scaleFactor,
        height: POPUP_INITIAL_HEIGHT * scaleFactor,
      }
      const { x, y } = resolvePopupPlacement(sprite, popupSizePhys, workArea)
      await openPetPopup({ width: POPUP_INITIAL_WIDTH, height: POPUP_INITIAL_HEIGHT, x, y })
    })()
  }

  // Persist the resting position back into PetSettings. `save` is a shallow
  // top-level merge, so the whole `petSettings` (with the nested desktopPet)
  // must be passed. Read the latest snapshot at call time — wander settles
  // long after the closure that scheduled them was rendered.
  const persistOverlayPosition = async (x: number, y: number) => {
    const latest = useSettingsStore.getState().settings?.petSettings ?? pet
    const latestDesktop = latest.desktopPet ?? desktopPet
    await save({
      petSettings: {
        ...latest,
        desktopPet: { ...latestDesktop, position: { x, y } },
      },
    })
  }
  const persistRef = useRef(persistOverlayPosition)
  useEffect(() => {
    persistRef.current = persistOverlayPosition
  })

  // Autonomous wandering + drag-throw physics. Pauses while the user drags,
  // the quick menu is open, a bubble is showing, the window is hidden, or
  // click-through is on (a wandering pet you cannot grab is disorienting).
  const wander = desktopPet.wander ?? DEFAULT_PET_WANDER
  const locomotionPaused = dragging || Boolean(bubble) || hidden || desktopPet.clickThrough
  const { locomotion, scaleFactor, beginThrow } = usePetLocomotion({
    enabled: !reduced,
    paused: locomotionPaused,
    wander,
    lowPower: pet.lowPower ?? false,
    petSize: size,
    lastInteractionAtMs: () => lastInteractionRef.current,
    onSettle: (x, y) => void persistRef.current(x, y),
  })

  // Drag the OS window: the click-vs-drag threshold and release-velocity
  // sampling live in the shared gesture hook (also used by the in-app
  // widget); this view only owns what "moving" means here — the window's own
  // screen origin, fetched async on pointerdown since drag deltas must apply
  // relative to it once it lands.
  const originRef = useRef<{
    pointerId: number
    winX: number | null
    winY: number | null
  } | null>(null)

  const dragGesture = usePetDragGesture({
    onDragStart: () => setDragging(true), // pause wandering while the user holds the pet
    onDragMove: (dx, dy) => {
      const o = originRef.current
      if (!o || o.winX == null || o.winY == null) return // window origin not known yet
      void setPetWindowPosition(o.winX + dx, o.winY + dy)
    },
    onRelease: ({ wasDrag, dx, dy, vx, vy, event }) => {
      const o = originRef.current
      originRef.current = null
      if (wasDrag) {
        setDragging(false)
        if (o && o.winX != null && o.winY != null) {
          const x = o.winX + dx
          const y = o.winY + dy
          if (!reduced && Math.hypot(vx, vy) >= MIN_THROW_SPEED) {
            // A flick → ballistic fall; the landing persists the position.
            beginThrow(x, y, vx, vy)
          } else {
            void persistOverlayPosition(x, y)
          }
        }
        return
      }
      // A non-drag tap resolves the touched body zone → a zone-specific local
      // flourish (head=love, belly=happy, tail=surprised, body=petted) while
      // still sending the existing "petted" interaction over the bridge (XP
      // unchanged). The touch SFX rides this genuine user gesture (autoplay-safe).
      const rect = (event.currentTarget as Element).getBoundingClientRect()
      const localX = event.clientX - rect.left
      const localY = event.clientY - rect.top
      const zone = resolveHitZone(localX, localY, rect.width || size, locomotion.facing)
      usePetStore.getState().enqueueOneShot(reactionForZone(zone))
      sendInteractionRef.current("petted")
      void import("@/lib/pet/audio/sfx").then((m) =>
        m.playPetSfx("touch", pet.sound, {
          reducedMotion: reduced,
          nowHour: new Date().getHours(),
          isUserGesture: true,
        })
      )
    },
    onCancel: ({ wasDrag }) => {
      if (wasDrag) setDragging(false)
      originRef.current = null
    },
  })

  const handlePointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return // left button only; right-click stays free for the menu
    // Capture the screen origin synchronously (inside the gesture hook) so
    // click-vs-drag disambiguation never races this async window-position
    // fetch; fill the window origin when it lands.
    const id = e.pointerId
    originRef.current = { pointerId: id, winX: null, winY: null }
    void (async () => {
      const winPos = await getPetWindowPosition()
      const base = winPos ?? { x: 0, y: 0 }
      const o = originRef.current
      if (o && o.pointerId === id) {
        o.winX = base.x
        o.winY = base.y
      }
    })()
    dragGesture.onPointerDown(e)
  }

  const containerStyle = useMemo(() => ({ width: size, height: size }), [size])

  // Celebratory SFX on level-up / evolve. Post-interaction (no user gesture):
  // plays only if the AudioContext was already unlocked by an earlier tap,
  // otherwise a silent no-op.
  const lastCelebrateRef = useRef<string | null>(null)
  useEffect(() => {
    if ((oneShot === "levelUp" || oneShot === "evolving") && oneShot !== lastCelebrateRef.current) {
      void import("@/lib/pet/audio/sfx").then((m) =>
        m.playPetSfx("levelUp", pet.sound, {
          reducedMotion: reduced,
          nowHour: new Date().getHours(),
          isUserGesture: false,
        })
      )
    }
    lastCelebrateRef.current = oneShot
  }, [oneShot, pet.sound, reduced])

  return (
    <div
      data-testid="pet-overlay-root"
      data-pet-overlay-root
      onContextMenu={handleContextMenu}
      // Bottom-anchored so the pet's feet sit on the window bottom — the
      // wander ground math rests the window bottom on the work-area bottom.
      className="flex h-screen w-screen select-none flex-col items-center justify-end overflow-hidden bg-transparent"
    >
      {bubble && <PetBubbleView bubble={bubble} className="mb-2" />}
      {profile && view ? (
        <div
          data-testid="pet-overlay-pet"
          role="img"
          aria-label={t("petLabel")}
          className="cursor-grab touch-none active:cursor-grabbing"
          style={containerStyle}
          onPointerDown={handlePointerDown}
          onPointerMove={dragGesture.onPointerMove}
          onPointerUp={dragGesture.onPointerUp}
          onPointerCancel={dragGesture.onPointerCancel}
        >
          <PetRenderer
            bones={view.effectiveBones}
            stage={profile.stage}
            state={withCareCondition(state, view.condition)}
            oneShot={oneShot}
            flavor={profile.evolutionFlavor}
            reducedMotion={reduced}
            size={size}
            skinId={skinId}
            locomotion={locomotion}
            // Pause idle micro-motion while hidden OR click-through (a pet the
            // user can't interact with doesn't need to keep breathing).
            paused={hidden || desktopPet.clickThrough}
          />
        </div>
      ) : null}
    </div>
  )
}
