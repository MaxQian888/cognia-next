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
import { usePetStore } from "@/stores/pet/pet-store"
import { startOverlayPetBridge } from "@/lib/pet/events/cross-window-bridge"
import {
  closePetWindow,
  getPetWindowPosition,
  resizePetWindow,
  setPetClickThrough,
  setPetWindowPosition,
  showMainWindow,
} from "@/lib/tauri/pet-window"
import {
  MIN_THROW_SPEED,
  overlayWindowSize,
  releaseVelocityFromSamples,
  type PointerSample,
} from "@/lib/pet/overlay-geometry"
import { reactionForZone, resolveHitZone } from "@/lib/pet/interaction/hit-zones"
import { resolveEffectiveSkin } from "./skins/resolve-effective-skin"
import { PetRenderer } from "./pet-renderer"
import { PetBubbleView } from "./pet-bubble"
import { PetQuickMenu } from "./pet-quick-menu"
import { SendIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

const DRAG_THRESHOLD_PX = 4

/** Pointer samples kept for the release-velocity estimate. */
const MAX_DRAG_SAMPLES = 8

// Extra vertical room the window grows by while the (upward-opening) quick menu
// is visible, restored to the resting box on close.
const MENU_GROW_H = 240

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
  const [menuOpen, setMenuOpen] = useState(false)
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

  // Talk composer (quick-menu "Talk" opens it). The typed text rides the
  // bridge to the main window, which runs the LLM side channel and broadcasts
  // the reply bubble back — this window never builds an LLM client.
  const [talkOpen, setTalkOpen] = useState(false)
  const [talkText, setTalkText] = useState("")
  const submitTalk = () => {
    const text = talkText.trim()
    sendInteractionRef.current("talked", text || undefined)
    setTalkText("")
    setTalkOpen(false)
  }

  // Persist the click-through flag alongside the live OS-window toggle. `save`
  // is a shallow top-level merge, so the whole `petSettings` is passed.
  const handleClickThrough = () => {
    void setPetClickThrough(true)
    void save({
      petSettings: { ...pet, desktopPet: { ...desktopPet, clickThrough: true } },
    })
  }

  // Grow the window UPWARD while the menu is open (resize extends the bottom,
  // so the window is shifted up by the same amount — the bottom-anchored pet
  // never moves on screen) and restore the chrome-inclusive resting box on
  // close. (Restoring to the bare pet size used to shed the chrome margins
  // after the first open, clipping the bubble — always go through
  // `overlayWindowSize`.)
  const handleMenuOpenChange = (open: boolean) => {
    setMenuOpen(open)
    const resting = overlayWindowSize(size)
    const growPhys = Math.round(MENU_GROW_H * scaleFactor)
    void (async () => {
      const pos = await getPetWindowPosition()
      if (open) {
        await resizePetWindow(resting.width, resting.height + MENU_GROW_H)
        if (pos) await setPetWindowPosition(pos.x, pos.y - growPhys)
      } else {
        await resizePetWindow(resting.width, resting.height)
        if (pos) await setPetWindowPosition(pos.x, pos.y + growPhys)
      }
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
  const locomotionPaused =
    dragging || menuOpen || Boolean(bubble) || hidden || desktopPet.clickThrough
  const { locomotion, scaleFactor, beginThrow } = usePetLocomotion({
    enabled: !reduced,
    paused: locomotionPaused,
    wander,
    lowPower: pet.lowPower ?? false,
    petSize: size,
    lastInteractionAtMs: () => lastInteractionRef.current,
    onSettle: (x, y) => void persistRef.current(x, y),
  })

  // Drag the OS window. We capture the pointer's screen origin + the window's
  // origin on pointerdown, then drive `setPetWindowPosition` (rAF-throttled)
  // once movement crosses the threshold. A sequence that never crosses the
  // threshold is a click → "pet" interaction; a fast release is a throw.
  const dragRef = useRef<{
    pointerId: number
    startScreenX: number
    startScreenY: number
    /** Window origin captured async on pointerdown; null until it lands. */
    winX: number | null
    winY: number | null
    dragging: boolean
    rafId: number | null
    pending: { x: number; y: number } | null
    /** Recent window positions for the release-velocity estimate. */
    samples: PointerSample[]
  } | null>(null)

  useEffect(() => {
    // Cancel any in-flight rAF on unmount.
    return () => {
      const d = dragRef.current
      if (d?.rafId != null) cancelAnimationFrame(d.rafId)
      dragRef.current = null
    }
  }, [])

  const flushMove = () => {
    const d = dragRef.current
    if (!d) return
    d.rafId = null
    if (!d.pending) return
    const { x, y } = d.pending
    d.pending = null
    void setPetWindowPosition(x, y)
  }

  const handlePointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return // left button only; right-click stays free for the menu
    // Capture the screen origin synchronously so click-vs-drag disambiguation
    // never races the async window-position fetch; fill the window origin when
    // it lands (window moves only apply once it's known).
    dragRef.current = {
      pointerId: e.pointerId,
      startScreenX: e.screenX,
      startScreenY: e.screenY,
      winX: null,
      winY: null,
      dragging: false,
      rafId: null,
      pending: null,
      samples: [],
    }
    const id = e.pointerId
    void (async () => {
      const winPos = await getPetWindowPosition()
      const base = winPos ?? { x: 0, y: 0 }
      const d = dragRef.current
      if (d && d.pointerId === id) {
        d.winX = base.x
        d.winY = base.y
      }
    })()
    ;(e.currentTarget as Element).setPointerCapture?.(e.pointerId)
  }

  const handlePointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current
    if (!d || d.pointerId !== e.pointerId) return
    const dx = e.screenX - d.startScreenX
    const dy = e.screenY - d.startScreenY
    if (!d.dragging && Math.abs(dx) < DRAG_THRESHOLD_PX && Math.abs(dy) < DRAG_THRESHOLD_PX) {
      return
    }
    if (!d.dragging) {
      d.dragging = true
      setDragging(true) // pause wandering while the user holds the pet
    }
    if (d.winX == null || d.winY == null) return // window origin not known yet
    const x = d.winX + dx
    const y = d.winY + dy
    d.samples.push({ x, y, tMs: performance.now() })
    if (d.samples.length > MAX_DRAG_SAMPLES) d.samples.shift()
    d.pending = { x, y }
    if (d.rafId == null) d.rafId = requestAnimationFrame(flushMove)
  }

  const endPointer = (e: React.PointerEvent, sendInteraction: () => void) => {
    const d = dragRef.current
    if (!d || d.pointerId !== e.pointerId) return
    ;(e.currentTarget as Element).releasePointerCapture?.(e.pointerId)
    if (d.rafId != null) {
      cancelAnimationFrame(d.rafId)
      d.rafId = null
    }
    const dx = e.screenX - d.startScreenX
    const dy = e.screenY - d.startScreenY
    const wasDrag = d.dragging
    const winX = d.winX
    const winY = d.winY
    const samples = d.samples
    dragRef.current = null
    if (wasDrag) setDragging(false)
    if (wasDrag && winX != null && winY != null) {
      const x = winX + dx
      const y = winY + dy
      const { vx, vy } = releaseVelocityFromSamples(samples)
      if (!reduced && Math.hypot(vx, vy) >= MIN_THROW_SPEED) {
        // A flick → ballistic fall; the landing persists the position.
        beginThrow(x, y, vx, vy)
      } else {
        void persistOverlayPosition(x, y)
      }
    } else if (!wasDrag) {
      sendInteraction()
    }
  }

  // A non-drag tap resolves the touched body zone → a zone-specific local
  // flourish (head=love, belly=happy, tail=surprised, body=petted) while still
  // sending the existing "petted" interaction over the bridge (XP unchanged).
  // The touch SFX rides this genuine user gesture (autoplay-safe).
  const onPointerUp = (e: React.PointerEvent) => {
    const rect = (e.currentTarget as Element).getBoundingClientRect()
    const localX = e.clientX - rect.left
    const localY = e.clientY - rect.top
    endPointer(e, () => {
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
    })
  }
  const onPointerCancel = (e: React.PointerEvent) => {
    const d = dragRef.current
    if (!d || d.pointerId !== e.pointerId) return
    if (d.rafId != null) cancelAnimationFrame(d.rafId)
    if (d.dragging) setDragging(false)
    dragRef.current = null
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
    <PetQuickMenu
      context="overlay"
      onOpenChange={handleMenuOpenChange}
      actions={{
        onFeed: () => sendInteractionRef.current("fed"),
        onPlay: () => sendInteractionRef.current("played"),
        onPet: () => sendInteractionRef.current("petted"),
        onTalk: () => setTalkOpen(true),
        onClickThrough: handleClickThrough,
        onHideDesktopPet: () => void closePetWindow(),
        onShowMainWindow: () => void showMainWindow(),
      }}
    >
      <div
        data-testid="pet-overlay-root"
        data-pet-overlay-root
        // Bottom-anchored so the pet's feet sit on the window bottom — the
        // wander ground math rests the window bottom on the work-area bottom.
        className="flex h-screen w-screen select-none flex-col items-center justify-end overflow-hidden bg-transparent"
      >
        {talkOpen ? (
          <div
            data-testid="pet-overlay-talk-composer"
            className="mb-2 flex w-full max-w-60 items-center gap-1.5 rounded-lg border bg-popover p-1.5 shadow-lg"
          >
            <Input
              autoFocus
              value={talkText}
              placeholder={t("talkPlaceholder")}
              aria-label={t("talkPlaceholder")}
              className="h-7 text-xs"
              maxLength={500}
              onChange={(e) => setTalkText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submitTalk()
                if (e.key === "Escape") {
                  setTalkText("")
                  setTalkOpen(false)
                }
              }}
            />
            <Button
              size="sm"
              className="h-7 w-7 shrink-0 p-0"
              onClick={submitTalk}
              aria-label={t("talkSend")}
            >
              <SendIcon className="size-3.5" />
            </Button>
          </div>
        ) : (
          bubble && <PetBubbleView bubble={bubble} className="mb-2" />
        )}
        {profile && view ? (
          <div
            data-testid="pet-overlay-pet"
            role="img"
            aria-label={t("petLabel")}
            className="cursor-grab touch-none active:cursor-grabbing"
            style={containerStyle}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerCancel}
          >
            <PetRenderer
              bones={view.effectiveBones}
              stage={profile.stage}
              state={state}
              oneShot={oneShot}
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
    </PetQuickMenu>
  )
}
