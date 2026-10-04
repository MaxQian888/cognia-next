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
//  - Drag the OS window with a small movement threshold (rAF-throttled),
//    converting the pointer's CSS-pixel deltas to the physical pixels every
//    window coordinate uses, and persist the resting position into
//    PetSettings on pointer-up.
//  - Follow pet-settings writes made in the other windows (size, wander,
//    gaze, click-through), so this long-lived webview never runs on the copy
//    it booted with.
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
import { useActiveSpritePack } from "@/hooks/pet/use-active-sprite-pack"
import { useDocumentHidden } from "@/hooks/pet/use-document-visible"
import { usePetLookTarget } from "@/hooks/pet/use-pet-look-target"
import { usePetLocomotion } from "@/hooks/pet/use-pet-locomotion"
import { usePetDragGesture } from "@/hooks/pet/use-pet-drag-gesture"
import { usePetStore } from "@/stores/pet/pet-store"
import { startOverlayPetBridge } from "@/lib/pet/events/cross-window-bridge"
import { startPetSettingsFollower, updateDesktopPetSettings } from "@/lib/pet/settings-sync"
import { schedulePetWindowReveal } from "@/lib/pet/reveal"
import {
  getPetWindowPosition,
  getPetWorkArea,
  onPetResume,
  onPetSuspend,
  openPetPopup,
  setPetWindowPosition,
  showMainWindow,
} from "@/lib/tauri/pet-window"
import type { PetConsoleTab } from "@/lib/pet/console-tabs"
import {
  MIN_THROW_SPEED,
  petBoxScreenRect,
  resolveCssToPhysicalScale,
} from "@/lib/pet/overlay-geometry"
import { LIVE2D_ONE_SHOT_HOLD_MS } from "@/lib/pet/live2d/constants"
import { POPUP_INITIAL_HEIGHT, POPUP_INITIAL_WIDTH } from "@/lib/pet/popup-geometry"
import { reactionForZone, resolveHitZone } from "@/lib/pet/interaction/hit-zones"
import { withCareCondition } from "@/lib/pet/state/reducer"
import { resolveCharacterSkinSelection } from "@/lib/pet/binding/resolve-skin"
import { resolveEffectiveSkin, selectionFromEffectiveSkin } from "./skins/resolve-effective-skin"
import { PetRenderer } from "./pet-renderer"
import { PetBubbleView } from "./pet-bubble"

export function PetOverlayView() {
  const t = useTranslations("pet.overlay")
  const settings = useSettingsStore((s) => s.settings)
  const pet: PetSettings = settings?.petSettings ?? DEFAULT_PET_SETTINGS
  const desktopPet = pet.desktopPet ?? DEFAULT_PET_DESKTOP_OVERLAY
  const size = desktopPet.size ?? DEFAULT_PET_DESKTOP_OVERLAY.size

  // Unified skin resolution — identical to the in-app widget: live2d renders
  // only when picked, the Cubism runtime is ready, and an active model exists;
  // otherwise the SVG mascot.
  const bridgedSelection = usePetStore((s) => s.appearanceSelection)
  const bridgedLookTarget = usePetStore((s) => s.lookTarget)
  const preferredSelection = bridgedSelection ?? resolveCharacterSkinSelection(pet, undefined)
  const { modelId, row: activeModel, coreReady } = useActiveLive2dModel(pet, preferredSelection)
  const { row: activeSpritePack } = useActiveSpritePack(pet, preferredSelection)
  const skinId = resolveEffectiveSkin(preferredSelection.skinId, {
    coreReady,
    hasActiveModel: Boolean(modelId),
    modelReady: activeModel?.compatibility?.status !== "invalid",
    hasActiveSpritePack: Boolean(activeSpritePack),
  })
  const selection = selectionFromEffectiveSkin(skinId, {
    modelId,
    packId: activeSpritePack?.id,
  })

  const osReduced = useReducedMotion()
  const reduced = pet.motion === "reduced" || (pet.motion === "auto" && Boolean(osReduced))

  const { profile, view } = usePet(undefined)
  const { state, oneShot } = usePetAnimationState(
    reduced,
    // Cubism motions run longer than the SVG specs — hold shots so they finish.
    skinId === "live2d" ? { holdFloorMs: LIVE2D_ONE_SHOT_HOLD_MS } : {}
  )
  const bubble = usePetStore((s) => s.bubble)
  const hidden = useDocumentHidden()
  const [dragging, setDragging] = useState(false)
  // Native hide/show signal from Rust (`pet://suspend` / `pet://resume`): a
  // hidden Tauri window does NOT reliably flip `document.hidden`, so without
  // this the ticker/rAF loops kept burning CPU behind a hidden overlay.
  const [nativeSuspended, setNativeSuspended] = useState(false)
  useEffect(() => {
    const offSuspend = onPetSuspend(() => setNativeSuspended(true))
    const offResume = onPetResume(() => setNativeSuspended(false))
    return () => {
      offSuspend()
      offResume()
    }
  }, [])
  // The native cursor is PHYSICAL screen pixels, so the pet's box must be
  // too: the window's CSS-pixel screen origin scaled by this webview's pixel
  // ratio, plus the box's inset (it is centered horizontally and
  // bottom-anchored inside the window's bubble headroom).
  const nativeLookTarget = usePetLookTarget({
    enabled: pet.gazeFollowing !== false && !reduced,
    native: true,
    suspended: hidden || nativeSuspended || desktopPet.clickThrough,
    getBounds: () => {
      const scale = resolveCssToPhysicalScale(null, window.devicePixelRatio)
      return {
        left: (window.screenX + Math.max(0, window.innerWidth - size) / 2) * scale,
        top: (window.screenY + Math.max(0, window.innerHeight - size)) * scale,
        width: size * scale,
        height: size * scale,
      }
    },
  })
  const lookTarget = nativeLookTarget ?? bridgedLookTarget

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

  // This webview lives as long as the overlay does (hide/show reuses it), so
  // it follows the other windows' pet-settings writes instead of rendering
  // the size / wander / gaze it booted with.
  useEffect(() => startPetSettingsFollower(), [])

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
  // A bubble action (e.g. "Open Insights") routes to the main window, which
  // owns the router, exactly the way the popup's "open console" does.
  const sendOpenConsoleRef = useRef<(tab: PetConsoleTab) => void>(() => {})
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
    sendOpenConsoleRef.current = (tab) => bridge.sendOpenConsole(tab)
    return () => {
      sendInteractionRef.current = () => {}
      sendOpenConsoleRef.current = () => {}
      bridge.dispose()
    }
  }, [])

  // Right-click opens the click popup in its own "pet-popup" window (the menu +
  // interaction panel + talk composer live there). The sprite window never
  // resizes or shifts for a menu. The popup is anchored to the pet's own box
  // (physical pixels, scaled by the monitor this window is on); the native
  // side places it above the pet (below when there is no room), clamps it to
  // that monitor's work area, and re-places it whenever it fits itself to its
  // card. Left-click (pet/drag) and the bubble are untouched.
  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault()
    void (async () => {
      const [pos, workArea] = await Promise.all([getPetWindowPosition(), getPetWorkArea()])
      if (!pos) return
      const scale = resolveCssToPhysicalScale(workArea?.scaleFactor, window.devicePixelRatio)
      await openPetPopup({
        width: POPUP_INITIAL_WIDTH,
        height: POPUP_INITIAL_HEIGHT,
        anchor: petBoxScreenRect(pos, size, scale),
      })
    })()
  }

  // Persist the resting position back into PetSettings, merged into the
  // freshly persisted record under the cross-window lock. A component
  // snapshot here reverted every pet setting the main window had changed
  // since this overlay opened (wander settles long after the closure that
  // scheduled them was rendered, and `save` replaces `petSettings` whole).
  const persistOverlayPosition = async (x: number, y: number) => {
    await updateDesktopPetSettings(() => ({ position: { x, y } }), DEFAULT_PET_DESKTOP_OVERLAY)
  }
  const persistRef = useRef(persistOverlayPosition)
  useEffect(() => {
    persistRef.current = persistOverlayPosition
  })

  // Autonomous wandering + drag-throw physics. Pauses while the user drags,
  // the quick menu is open, a bubble is showing, the window is hidden, or
  // click-through is on (a wandering pet you cannot grab is disorienting).
  const wander = desktopPet.wander ?? DEFAULT_PET_WANDER
  const locomotionPaused =
    dragging || Boolean(bubble) || hidden || nativeSuspended || desktopPet.clickThrough
  const { locomotion, beginThrow, settleAt } = usePetLocomotion({
    enabled: !reduced,
    paused: locomotionPaused,
    wander,
    lowPower: pet.lowPower ?? false,
    statsChaos: view?.effectiveStats.chaos ?? 0,
    petSize: size,
    lastInteractionAtMs: () => lastInteractionRef.current,
    onSettle: (x, y) => void persistRef.current(x, y),
    // A fall/throw settling plays the impact squash + dust locally.
    onLand: () => usePetStore.getState().enqueueOneShot("land"),
  })

  // Drag the OS window: the click-vs-drag threshold and release-velocity
  // sampling live in the shared gesture hook (also used by the in-app
  // widget); this view only owns what "moving" means here — the window's own
  // screen origin, fetched async on pointerdown since drag deltas must apply
  // relative to it once it lands.
  //
  // Units: the gesture reports CSS-pixel deltas (pointer `screenX`/`screenY`)
  // while the window origin and every position command are PHYSICAL pixels.
  // The scale is captured with the origin (the monitor's factor, falling
  // back to this webview's pixel ratio); without it the pet slid out from
  // under the cursor at half speed on a 2x display.
  const originRef = useRef<{
    pointerId: number
    winX: number | null
    winY: number | null
    scale: number
  } | null>(null)

  const dragGesture = usePetDragGesture({
    onDragStart: () => setDragging(true), // pause wandering while the user holds the pet
    onDragMove: (dx, dy) => {
      const o = originRef.current
      if (!o || o.winX == null || o.winY == null) return // window origin not known yet
      void setPetWindowPosition(o.winX + dx * o.scale, o.winY + dy * o.scale)
    },
    onRelease: ({ wasDrag, dx, dy, vx, vy, event }) => {
      const o = originRef.current
      originRef.current = null
      if (wasDrag) {
        setDragging(false)
        if (o && o.winX != null && o.winY != null) {
          const x = o.winX + dx * o.scale
          const y = o.winY + dy * o.scale
          // The throw threshold is a feel, measured in CSS px/s so it does
          // not change with the display; the physics runs in physical px.
          if (!reduced && Math.hypot(vx, vy) >= MIN_THROW_SPEED) {
            // A flick → ballistic fall; the landing persists the position.
            beginThrow(x, y, vx * o.scale, vy * o.scale)
          } else {
            // A placement: the pet stays where it was put. The engine adopts
            // the spot, or its next wander would start from the pre-drag
            // position and snap the window back there.
            settleAt(x, y)
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
    originRef.current = {
      pointerId: id,
      winX: null,
      winY: null,
      scale: resolveCssToPhysicalScale(null, window.devicePixelRatio),
    }
    void (async () => {
      const [winPos, workArea] = await Promise.all([getPetWindowPosition(), getPetWorkArea()])
      const base = winPos ?? { x: 0, y: 0 }
      const o = originRef.current
      if (o && o.pointerId === id) {
        o.winX = base.x
        o.winY = base.y
        o.scale = resolveCssToPhysicalScale(workArea?.scaleFactor, window.devicePixelRatio)
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
      {bubble && (
        <PetBubbleView
          bubble={bubble}
          className="mb-2"
          // Clickable only while the overlay takes the pointer: with
          // click-through on, the whole window ignores the cursor, and the
          // widget or the pet console remain the way in.
          onAction={(action) => {
            void showMainWindow()
            sendOpenConsoleRef.current(action.tab)
            usePetStore.getState().setBubble(null)
          }}
        />
      )}
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
            selection={selection}
            renderPriority="interactive"
            lookTarget={lookTarget}
            lowPower={pet.lowPower}
            locomotion={locomotion}
            mood={view.mood}
            speaking={Boolean(bubble)}
            held={dragging}
            // Pause idle micro-motion while hidden (document OR native window),
            // or click-through (a pet the user can't interact with doesn't
            // need to keep breathing).
            paused={hidden || nativeSuspended || desktopPet.clickThrough}
          />
        </div>
      ) : null}
    </div>
  )
}
