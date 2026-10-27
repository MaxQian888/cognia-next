"use client"

import {
  CircleCheckBig,
  EyeOff,
  LoaderCircle,
  Maximize2,
  MonitorPlay,
  PictureInPicture2,
  Scaling,
  X,
} from "lucide-react"
import { motion, useReducedMotion } from "motion/react"
import { useTranslations } from "next-intl"
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"

import { SANDBOX_DESKTOP_PANEL_ID } from "@/components/artifacts/dock-panel-meta"
import { useSessionSandboxDesktop } from "@/hooks/automation/use-session-sandbox-desktop"
import { revealSessionPanel } from "@/lib/artifacts/reveal"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { desktop } from "@/lib/automation/client"
import {
  beginComputerUsePipRun,
  retainComputerUsePipSession,
  retainComputerUsePipPresentation,
  useComputerUsePipPresentationIds,
  useComputerUsePipCaptureSuppressed,
  getComputerUsePipLayoutPreference,
  setComputerUsePipDismissed,
  setComputerUsePipHidden,
  setComputerUsePipLayoutPreference,
  setComputerUsePipRunEnded,
  useComputerUsePip,
  useComputerUsePipAlwaysHidden,
} from "@/lib/automation/computer-use-pip"
import {
  computePictureInPictureAnchors,
  computePictureInPictureTiles,
  computePictureInPictureSize,
  PICTURE_IN_PICTURE_CHROME_HEIGHT,
  type PictureInPictureAlignment,
  type PictureInPicturePoint,
  type PictureInPictureRect,
} from "@/lib/automation/picture-in-picture-layout"
import { cn } from "@/lib/utils"
import {
  useComputerUsePipHost,
  type ComputerUsePipHostGeometry,
} from "@/hooks/automation/use-computer-use-pip-host"
import {
  loadComputerUsePipPreference,
  useComputerUsePipClock,
} from "@/lib/automation/computer-use-pip-resources"
import { useSessionRunId, useSessionStatus } from "@/stores/chat"
import { ComputerUseStreamPreview } from "./computer-use-stream-preview"

const ALIGNMENTS: PictureInPictureAlignment[] = ["bottomRight", "bottomLeft", "topLeft", "topRight"]
const MIN_SIZE = 220
const DEFAULT_BOX = 250
const EDGE = 24
const FRESHNESS_THRESHOLD_S = 5
const TERMINAL_COLLAPSE_MS = 2500
const PILL_SIZE = { width: 190, height: 36 }
const ACTION_TRANSLATION_KEYS = {
  // App-session surface. These are the names the tools actually publish today;
  // the map previously held only the pre-app-session action vocabulary, so a
  // live run showed raw tool ids where a label belonged.
  get_app_state: "getAppState",
  list_apps: "listApps",
  query_elements: "queryElements",
  expand_element: "expandElement",
  perform_action: "performAction",
  zoom: "zoom",
  screenshot: "screenshot",
  left_click: "leftClick",
  right_click: "rightClick",
  middle_click: "middleClick",
  double_click: "doubleClick",
  triple_click: "tripleClick",
  mouse_move: "mouseMove",
  left_click_drag: "drag",
  left_mouse_down: "mouseDown",
  left_mouse_up: "mouseUp",
  scroll: "scroll",
  type: "type",
  key: "key",
  hold_key: "holdKey",
  wait: "wait",
  cursor_position: "cursorPosition",
  find_text: "findText",
  click_text: "clickText",
} as const

// The resize grip sits at the corner opposite the pinned anchor.
const HANDLE_CORNER: Record<PictureInPictureAlignment, string> = {
  bottomRight: "left-0 top-0",
  bottomLeft: "right-0 top-0",
  topLeft: "right-0 bottom-0",
  topRight: "left-0 bottom-0",
}

type DragMode = "move" | "resize"

interface DragSession {
  mode: DragMode
  pointerX: number
  pointerY: number
  startPoint: PictureInPicturePoint
  startWidth: number
  startHeight: number
  startBox: number
  alignment: PictureInPictureAlignment
  pointerId: number | null
  hostWidth: number
  hostHeight: number
}

function rectOf(element: Element): PictureInPictureRect {
  const rect = element.getBoundingClientRect()
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
}

function clampN(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max))
}

// How far the surface grows for a pointer delta, given which corner is pinned.
export function resizeGrowth(alignment: PictureInPictureAlignment, dx: number, dy: number): number {
  switch (alignment) {
    case "bottomRight":
      return Math.max(-dx, -dy)
    case "bottomLeft":
      return Math.max(dx, -dy)
    case "topLeft":
      return Math.max(dx, dy)
    case "topRight":
      return Math.max(-dx, dy)
  }
}

export function ComputerUsePictureInPicture({ sessionId }: { sessionId: string }) {
  const ids = useComputerUsePipPresentationIds(sessionId)
  const alwaysHidden = useComputerUsePipAlwaysHidden()
  const { ref, geometry, hasHost } = useComputerUsePipHost(ids.length > 0 && !alwaysHidden)
  const suppressed = useComputerUsePipCaptureSuppressed()
  const runId = useSessionRunId(sessionId)
  const status = useSessionStatus(sessionId)
  const busy = status === "streaming" || status === "awaiting_approval"
  const sandboxDesktop = useSessionSandboxDesktop(sessionId)
  const [selected, setSelected] = useState<string | null>(null)
  const [preferenceLoaded, setPreferenceLoaded] = useState(false)
  const focused = selected && ids.includes(selected) ? selected : ids.at(-1)
  const layout = computePictureInPictureTiles(geometry.rect, geometry.obstacles, ids.length)
  const initial = ids.slice(-layout.tiles.length)
  const visible =
    focused && !initial.includes(focused) ? [focused, ...initial.slice(0, -1)] : initial
  const hasActivity = ids.length > 0
  const canPaint = preferenceLoaded && !alwaysHidden && (!hasHost || geometry.visible)
  useEffect(() => {
    if (!hasActivity || preferenceLoaded) return
    let cancelled = false
    void loadComputerUsePipPreference(() => desktop.settingsGet()).then(() => {
      if (!cancelled) setPreferenceLoaded(true)
    })
    return () => {
      cancelled = true
    }
  }, [hasActivity, preferenceLoaded])
  useLayoutEffect(() => {
    if (busy) beginComputerUsePipRun(sessionId, runId)
  }, [sessionId, runId, busy])
  useEffect(() => retainComputerUsePipSession(sessionId), [sessionId])
  return (
    <div
      ref={ref}
      className="contents"
      data-computer-use-pip-layer
      aria-hidden={suppressed || undefined}
      style={{ visibility: suppressed ? "hidden" : undefined }}
    >
      {canPaint &&
        visible.map((id, index) => (
          <ComputerUsePipSurface
            key={`${sessionId}:${id}`}
            sessionId={sessionId}
            presentationId={id}
            geometry={geometry}
            slot={ids.length > 1 ? layout.tiles[index] : undefined}
            focused={id === focused}
            onFocus={() => setSelected(id)}
            captureSuppressed={suppressed}
            sandboxDesktop={sandboxDesktop}
            preferenceLoaded={preferenceLoaded}
          />
        ))}
      {canPaint && ids.length > 1 && (
        <ComputerUsePipSelector
          sessionId={sessionId}
          ids={ids}
          selected={focused}
          onSelect={setSelected}
          position={layout.selector}
        />
      )}
    </div>
  )
}

function ComputerUsePipSelector({
  sessionId,
  ids,
  selected,
  onSelect,
  position,
}: {
  sessionId: string
  ids: readonly string[]
  selected?: string
  onSelect: (id: string) => void
  position: PictureInPicturePoint & { width: number }
}) {
  const t = useTranslations("automation.pictureInPicture")
  const alwaysHidden = useComputerUsePipAlwaysHidden()
  if (alwaysHidden) return null
  return (
    <div
      role="toolbar"
      aria-label={t("previews")}
      className="absolute z-30 flex h-8 gap-1 overflow-x-auto rounded-lg border bg-background/95 p-1 shadow-lg"
      style={{ left: position.x, top: position.y, maxWidth: position.width }}
      onKeyDown={(event) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return
        event.preventDefault()
        const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button")]
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
        buttons[
          (index + (event.key === "ArrowRight" ? 1 : buttons.length - 1)) % buttons.length
        ]?.focus()
      }}
    >
      {ids.map((id, index) => (
        <ComputerUsePipSelectorButton
          key={id}
          sessionId={sessionId}
          presentationId={id}
          selected={id === selected}
          onSelect={onSelect}
          number={index + 1}
        />
      ))}
    </div>
  )
}
function ComputerUsePipSelectorButton({
  sessionId,
  presentationId,
  selected,
  onSelect,
  number,
}: {
  sessionId: string
  presentationId: string
  selected: boolean
  onSelect: (id: string) => void
  number: number
}) {
  const t = useTranslations("automation.pictureInPicture")
  const snapshot = useComputerUsePip(sessionId, presentationId)
  const target = useSessionSandboxDesktop(sessionId, snapshot.targetConnectionId ?? null)
  const label = t("previewLabel", {
    app: snapshot.label ?? t("title"),
    number,
    desktop: target?.name ?? t(snapshot.targetConnectionId ? "remoteDesktop" : "localDesktop"),
  })
  return (
    <Button
      type="button"
      variant={selected ? "secondary" : "ghost"}
      size="sm"
      className="h-6 max-w-36 shrink-0 truncate px-2 text-xs"
      aria-label={t("selectPreview", { target: label })}
      aria-pressed={selected}
      onClick={() => {
        setComputerUsePipHidden(sessionId, false, presentationId)
        setComputerUsePipDismissed(sessionId, false, presentationId)
        onSelect(presentationId)
      }}
    >
      <span className="min-w-0 truncate">{label}</span>
    </Button>
  )
}

function ComputerUsePipSurface({
  sessionId,
  presentationId,
  geometry,
  slot,
  focused,
  onFocus,
  captureSuppressed,
  sandboxDesktop,
  preferenceLoaded,
}: {
  sessionId: string
  presentationId: string
  geometry: ComputerUsePipHostGeometry
  slot?: PictureInPictureRect
  focused: boolean
  onFocus: () => void
  captureSuppressed: boolean
  sandboxDesktop: ReturnType<typeof useSessionSandboxDesktop>
  preferenceLoaded: boolean
}) {
  const t = useTranslations("automation.pictureInPicture")
  const snapshot = useComputerUsePip(sessionId, presentationId)
  const targetDesktop = useSessionSandboxDesktop(sessionId, snapshot.targetConnectionId ?? null)
  const hasActivity = snapshot.action != null
  const hasFrame = snapshot.frame != null
  const frameWidth = snapshot.frame?.width
  const frameHeight = snapshot.frame?.height
  const alwaysHidden = useComputerUsePipAlwaysHidden()
  const status = useSessionStatus(sessionId)
  const runId = useSessionRunId(sessionId)
  const previewSandbox =
    targetDesktop?.connectionId === snapshot.targetConnectionId ? targetDesktop : null
  const canRevealDesktop = Boolean(
    sandboxDesktop && sandboxDesktop.connectionId === snapshot.targetConnectionId
  )
  const streamKey = `${sessionId}:${presentationId}:${runId}:${previewSandbox?.connectionId ?? "host"}`
  const [streamPresentation, setStreamPresentation] = useState<{
    key: string
    ready: boolean
  } | null>(null)
  const onStreamReady = useCallback(
    (ready: boolean) => setStreamPresentation({ key: streamKey, ready }),
    [streamKey]
  )
  const busy = status === "streaming" || status === "awaiting_approval"
  const terminalErrored = snapshot.phase === "error" || (snapshot.ended && status === "error")
  const reduce = useReducedMotion()
  const rootRef = useRef<HTMLDivElement>(null)
  const hostRef = useRef<Element | null>(null)
  const dragRef = useRef<DragSession | null>(null)
  const [alignment, setAlignment] = useState<PictureInPictureAlignment>(
    () => getComputerUsePipLayoutPreference().alignment
  )
  const [freePoint, setFreePoint] = useState<PictureInPicturePoint | null>(null)
  const [userBox, setUserBox] = useState(
    () => getComputerUsePipLayoutPreference().preferredLongEdge
  )
  const [dragging, setDragging] = useState(false)
  const [interacting, setInteracting] = useState(false)
  const [zoomOpen, setZoomOpen] = useState(false)
  const pageVisible = geometry.visible
  const [failedFrameSrc, setFailedFrameSrc] = useState<string | null>(null)
  const expanded =
    preferenceLoaded &&
    !alwaysHidden &&
    hasActivity &&
    !snapshot.hidden &&
    !snapshot.dismissed &&
    !snapshot.captureSuppressed
  const streamLive =
    expanded &&
    busy &&
    pageVisible &&
    !snapshot.ended &&
    streamPresentation?.key === streamKey &&
    streamPresentation.ready
  useEffect(() => {
    if (expanded && pageVisible) return retainComputerUsePipPresentation(sessionId, presentationId)
  }, [expanded, pageVisible, sessionId, presentationId])
  const baseRect = geometry.rect
  const dims = slot
    ? {
        width: slot.width,
        height: slot.height,
        mediaWidth: slot.width,
        mediaHeight: Math.max(1, slot.height - PICTURE_IN_PICTURE_CHROME_HEIGHT),
      }
    : geometry.host
      ? computePictureInPictureSize({
          aspectRatio: frameWidth && frameHeight ? frameWidth / frameHeight : 1,
          preferredLongEdge: userBox,
          hostWidth: baseRect.width,
          hostHeight: baseRect.height,
        })
      : {
          width: DEFAULT_BOX,
          height: DEFAULT_BOX + PICTURE_IN_PICTURE_CHROME_HEIGHT,
          mediaWidth: DEFAULT_BOX,
          mediaHeight: DEFAULT_BOX,
        }
  const anchor = computePictureInPictureAnchors(geometry.rect, geometry.obstacles, dims)[alignment]
  const point = slot
    ? { x: slot.x + slot.width - dims.width, y: slot.y + slot.height - dims.height }
    : { x: anchor.x - geometry.rect.x, y: anchor.y - geometry.rect.y }
  const pillWidth = Math.min(PILL_SIZE.width, slot?.width ?? geometry.rect.width)
  const pillAnchor = computePictureInPictureAnchors(geometry.rect, geometry.obstacles, {
    width: pillWidth,
    height: PILL_SIZE.height,
  })[alignment]
  const pillPoint = slot
    ? { x: slot.x, y: slot.y }
    : { x: pillAnchor.x - geometry.rect.x, y: pillAnchor.y - geometry.rect.y }
  const now = useComputerUsePipClock(
    busy && !snapshot.ended && expanded && hasFrame && pageVisible && !streamLive
  )
  useLayoutEffect(() => {
    hostRef.current = geometry.host
  }, [geometry.host])
  const prevBusyRef = useRef(busy)
  const busySessionIdRef = useRef(sessionId)
  const latestRef = useRef({ point, dims, freePoint, userBox, alignment })

  // Start a move/resize gesture. Reads the current geometry from `latestRef`
  // (kept fresh by the effect below) so the callback can stay stable.
  const startDrag = useCallback((mode: DragMode, e: React.PointerEvent) => {
    if (mode === "move" && (e.target as HTMLElement).closest("button")) return
    e.preventDefault()
    const s = latestRef.current
    const host = hostRef.current
    if (!host) return
    const hostRect = rectOf(host)
    dragRef.current = {
      mode,
      pointerX: e.clientX,
      pointerY: e.clientY,
      startPoint: s.freePoint ?? s.point ?? { x: 0, y: 0 },
      startWidth: s.dims.width,
      startHeight: s.dims.height,
      startBox: s.userBox,
      alignment: s.alignment,
      pointerId: Number.isFinite(e.pointerId) ? e.pointerId : null,
      hostWidth: hostRect.width,
      hostHeight: hostRect.height,
    }
    if (Number.isFinite(e.pointerId)) e.currentTarget.setPointerCapture?.(e.pointerId)
    setDragging(true)
  }, [])

  // Mirror the geometry the pointer handlers need into a ref (read off-render).
  useEffect(() => {
    latestRef.current = { point, dims, freePoint, userBox, alignment }
  })

  // Turn-end detection: when the owning session leaves the running state with a
  // surface still up, flag the terminal state (external store, not React state).
  useEffect(() => {
    if (busySessionIdRef.current !== sessionId) {
      busySessionIdRef.current = sessionId
      prevBusyRef.current = busy
      return
    }
    const wasBusy = prevBusyRef.current
    prevBusyRef.current = busy
    const completedWhileUnmounted = !wasBusy && !busy && hasActivity && snapshot.phase !== "running"
    if (!snapshot.ended && hasActivity && ((wasBusy && !busy) || completedWhileUnmounted)) {
      setComputerUsePipRunEnded(sessionId)
    }
  }, [busy, hasActivity, sessionId, snapshot.ended, snapshot.phase])

  // Terminal → auto-collapse to the pill after a short beat.
  useEffect(() => {
    if (!snapshot.ended || terminalErrored || interacting || zoomOpen || !pageVisible) return
    const id = setTimeout(
      () => setComputerUsePipHidden(sessionId, true, presentationId),
      TERMINAL_COLLAPSE_MS
    )
    return () => clearTimeout(id)
  }, [
    snapshot.ended,
    terminalErrored,
    interacting,
    sessionId,
    presentationId,
    zoomOpen,
    pageVisible,
  ])

  // Pointer drag/resize — registered once; the handlers no-op unless a drag is
  // active (dragRef). Free-dragging repositions; releasing a move snaps to the
  // nearest corner so obstacle avoidance and the anchor model still apply.
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const drag = dragRef.current
      const host = hostRef.current
      if (!drag || !host) return
      if (drag.pointerId != null && e.pointerId !== drag.pointerId) return
      const dx = e.clientX - drag.pointerX
      const dy = e.clientY - drag.pointerY
      if (drag.mode === "move") {
        setFreePoint({
          x: clampN(drag.startPoint.x + dx, 0, drag.hostWidth - drag.startWidth),
          y: clampN(drag.startPoint.y + dy, 0, drag.hostHeight - drag.startHeight),
        })
      } else {
        const hostMax = Math.max(
          MIN_SIZE,
          Math.max(
            drag.hostWidth - 2 * EDGE,
            drag.hostHeight - 2 * EDGE - PICTURE_IN_PICTURE_CHROME_HEIGHT
          )
        )
        setUserBox(clampN(drag.startBox + resizeGrowth(drag.alignment, dx, dy), MIN_SIZE, hostMax))
      }
    }
    const finishDrag = (snap: boolean, e?: PointerEvent) => {
      const drag = dragRef.current
      const host = hostRef.current
      if (!drag) return
      if (e && drag.pointerId != null && e.pointerId !== drag.pointerId) return
      if (snap && drag.mode === "move" && host) {
        const rect = rectOf(host)
        const fp = latestRef.current.freePoint ?? drag.startPoint
        const cx = fp.x + drag.startWidth / 2
        const cy = fp.y + drag.startHeight / 2
        const horiz = cx < rect.width / 2 ? "Left" : "Right"
        const vert = cy < rect.height / 2 ? "top" : "bottom"
        const nextAlignment = `${vert}${horiz}` as PictureInPictureAlignment
        setAlignment(nextAlignment)
        setComputerUsePipLayoutPreference({
          alignment: nextAlignment,
          preferredLongEdge: latestRef.current.userBox,
        })
      } else if (snap && drag.mode === "resize") {
        setComputerUsePipLayoutPreference({
          alignment: latestRef.current.alignment,
          preferredLongEdge: latestRef.current.userBox,
        })
      }
      dragRef.current = null
      setFreePoint(null)
      setDragging(false)
      setInteracting(false)
    }
    const onUp = (e: PointerEvent) => finishDrag(true, e)
    const onCancel = (e: PointerEvent) => finishDrag(false, e)
    const onBlur = () => finishDrag(false)
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") finishDrag(false)
    }
    window.addEventListener("pointermove", onMove)
    window.addEventListener("pointerup", onUp)
    window.addEventListener("pointercancel", onCancel)
    window.addEventListener("blur", onBlur)
    window.addEventListener("keydown", onKeyDown)
    return () => {
      window.removeEventListener("pointermove", onMove)
      window.removeEventListener("pointerup", onUp)
      window.removeEventListener("pointercancel", onCancel)
      window.removeEventListener("blur", onBlur)
      window.removeEventListener("keydown", onKeyDown)
    }
  }, [])

  if (
    !preferenceLoaded ||
    alwaysHidden ||
    snapshot.action == null ||
    snapshot.dismissed ||
    snapshot.captureSuppressed
  )
    return null

  if (snapshot.hidden) {
    return (
      <div
        ref={rootRef}
        className="absolute z-30"
        style={{
          ...(pillPoint ? { left: pillPoint.x, top: pillPoint.y } : { right: EDGE, bottom: EDGE }),
          maxWidth: pillWidth,
        }}
      >
        <motion.div
          initial={reduce ? false : { opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
        >
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="max-w-full gap-2 overflow-hidden shadow-lg"
            aria-label={t("show")}
            onClick={() => setComputerUsePipHidden(sessionId, false, presentationId)}
          >
            <MonitorPlay className="size-4" aria-hidden />
            <span className="truncate">{t("show")}</span>
          </Button>
        </motion.div>
      </div>
    )
  }

  const errored = terminalErrored
  const freshness =
    !snapshot.ended && busy && snapshot.frame && !streamLive
      ? (() => {
          const ageS = Math.max(0, Math.round((now - snapshot.frame.capturedAt) / 1000))
          return ageS < FRESHNESS_THRESHOLD_S ? t("justNow") : t("secondsAgo", { seconds: ageS })
        })()
      : null
  const actionTranslationKey =
    snapshot.action &&
    ACTION_TRANSLATION_KEYS[snapshot.action as keyof typeof ACTION_TRANSLATION_KEYS]
  const actionLabel = actionTranslationKey
    ? t(`actions.${actionTranslationKey}` as Parameters<typeof t>[0])
    : snapshot.action

  const activePoint = freePoint ?? point
  const style = activePoint
    ? { left: activePoint.x, top: activePoint.y, width: dims.width, height: dims.height }
    : { right: EDGE, bottom: EDGE, width: dims.width, height: dims.height }

  return (
    <>
      <motion.div
        ref={rootRef}
        role="region"
        aria-label={snapshot.label ?? t("title")}
        data-pip-presentation={presentationId}
        className={cn(
          "absolute z-30 flex select-none overflow-hidden rounded-xl border bg-background/95 shadow-2xl backdrop-blur",
          !reduce && !dragging && "transition-[left,top,width,height] duration-200 ease-out",
          snapshot.ended && "border-dashed border-muted-foreground/30"
        )}
        style={style}
        initial={reduce ? false : { opacity: 0, scale: 0.96 }}
        animate={{ opacity: 1, scale: 1 }}
        onPointerEnter={() => setInteracting(true)}
        onPointerLeave={() => {
          if (!dragging) setInteracting(false)
        }}
        onFocusCapture={() => {
          setInteracting(true)
          onFocus()
        }}
        onBlurCapture={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
            setInteracting(false)
          }
        }}
      >
        <>
          <div className="flex min-w-0 flex-1 flex-col">
            <div
              className="flex h-9 shrink-0 touch-none cursor-grab items-center gap-1 overflow-x-auto border-b px-2 active:cursor-grabbing"
              onPointerDown={(e) => {
                onFocus()
                if (!slot) startDrag("move", e)
              }}
            >
              {dims.width >= 220 && (
                <MonitorPlay className="size-4 shrink-0 text-primary" aria-hidden />
              )}
              <span className="min-w-0 flex-1 truncate text-xs font-medium">
                {snapshot.label ?? (dims.width >= 220 ? t("title") : null)}
              </span>
              {snapshot.phase === "running" && !snapshot.ended && (
                <LoaderCircle className="size-3.5 animate-spin text-muted-foreground" aria-hidden />
              )}
              {/* Reveal the dock only when it still represents this presentation's target. */}
              {canRevealDesktop ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      aria-label={t("openSandboxDesktop")}
                      onClick={() => revealSessionPanel(sessionId, SANDBOX_DESKTOP_PANEL_ID)}
                    >
                      <MonitorPlay className="size-3.5" aria-hidden />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent style={{ visibility: captureSuppressed ? "hidden" : undefined }}>
                    {t("openSandboxDesktop")}
                  </TooltipContent>
                </Tooltip>
              ) : null}
              {!slot && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      aria-label={t("move")}
                      onClick={() => {
                        const index = ALIGNMENTS.indexOf(alignment)
                        const nextAlignment = ALIGNMENTS[(index + 1) % ALIGNMENTS.length]
                        setAlignment(nextAlignment)
                        setComputerUsePipLayoutPreference({
                          alignment: nextAlignment,
                          preferredLongEdge: userBox,
                        })
                      }}
                    >
                      <PictureInPicture2 className="size-3.5" aria-hidden />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent style={{ visibility: captureSuppressed ? "hidden" : undefined }}>
                    {t("move")}
                  </TooltipContent>
                </Tooltip>
              )}
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    aria-label={t("hide")}
                    onClick={() => setComputerUsePipHidden(sessionId, true, presentationId)}
                  >
                    <EyeOff className="size-3.5" aria-hidden />
                  </Button>
                </TooltipTrigger>
                <TooltipContent style={{ visibility: captureSuppressed ? "hidden" : undefined }}>
                  {t("hide")}
                </TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    aria-label={t("close")}
                    onClick={() => setComputerUsePipDismissed(sessionId, true, presentationId)}
                  >
                    <X className="size-3.5" aria-hidden />
                  </Button>
                </TooltipTrigger>
                <TooltipContent style={{ visibility: captureSuppressed ? "hidden" : undefined }}>
                  {t("close")}
                </TooltipContent>
              </Tooltip>
            </div>
            <div className="relative min-h-0 flex-1 bg-black">
              {snapshot.frame ||
              (previewSandbox?.enabled && previewSandbox.allowStreaming !== false) ? (
                <button
                  type="button"
                  aria-label={t("viewLarger")}
                  disabled={!snapshot.frame && !(canRevealDesktop && previewSandbox?.enabled)}
                  onClick={() =>
                    previewSandbox?.enabled && canRevealDesktop
                      ? revealSessionPanel(sessionId, SANDBOX_DESKTOP_PANEL_ID)
                      : snapshot.frame && setZoomOpen(true)
                  }
                  className="group absolute inset-0 cursor-zoom-in disabled:cursor-default"
                >
                  {/* A stable image keeps transitions from retaining every incoming frame. */}
                  {snapshot.frame && (
                    // eslint-disable-next-line @next/next/no-img-element -- ephemeral native screenshot
                    <img
                      src={snapshot.frame.src}
                      alt={t("screenAlt")}
                      decoding="async"
                      draggable={false}
                      className={cn(
                        "absolute inset-0 size-full object-contain",
                        failedFrameSrc === snapshot.frame.src && "opacity-0"
                      )}
                      onLoad={() => {
                        if (failedFrameSrc !== null) setFailedFrameSrc(null)
                      }}
                      onError={() => setFailedFrameSrc(snapshot.frame?.src ?? null)}
                    />
                  )}
                  {snapshot.frame && failedFrameSrc === snapshot.frame.src && (
                    <span
                      role="status"
                      className="absolute inset-0 flex items-center justify-center px-3 text-xs text-white/70"
                    >
                      {t("previewUnavailable")}
                    </span>
                  )}
                  {!snapshot.frame && (
                    <span className="text-xs text-white/70">
                      {t(snapshot.frameUnavailable ? "previewUnavailable" : "waitingForFrame")}
                    </span>
                  )}
                  {previewSandbox?.enabled && previewSandbox.allowStreaming !== false && (
                    <ComputerUseStreamPreview
                      key={`${sessionId}:${presentationId}:${runId}:${previewSandbox.connectionId}`}
                      connectionId={previewSandbox.connectionId}
                      active={busy && !snapshot.ended && pageVisible}
                      priority={focused}
                      onReadyChange={onStreamReady}
                      hasFrame={hasFrame}
                    />
                  )}
                  <Maximize2
                    className="absolute right-1.5 top-1.5 size-4 text-white/70 opacity-0 transition-opacity group-hover:opacity-100"
                    aria-hidden
                  />
                </button>
              ) : (
                <div className="flex size-full items-center justify-center text-xs text-white/70">
                  {t(snapshot.frameUnavailable ? "previewUnavailable" : "waitingForFrame")}
                </div>
              )}
              <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center gap-1 bg-black/70 px-2 py-1 text-[10px] text-white">
                <span
                  role="status"
                  aria-live="polite"
                  className={cn(
                    "flex min-w-0 flex-1 items-center gap-1 truncate",
                    errored && "text-red-300",
                    snapshot.ended && !errored && "text-emerald-300"
                  )}
                >
                  {errored ? (
                    (snapshot.error ?? t("failed"))
                  ) : snapshot.ended ? (
                    <>
                      <CircleCheckBig className="size-3 shrink-0" aria-hidden />
                      {t("done")}
                    </>
                  ) : (
                    t(streamLive ? "liveActivity" : "activity", { action: actionLabel })
                  )}
                </span>
                {freshness && (
                  <span aria-hidden className="shrink-0 text-white/60">
                    {freshness}
                  </span>
                )}
              </div>
            </div>
          </div>
          {!slot && (
            <button
              type="button"
              aria-label={t("resize")}
              data-pip-resize-handle
              onPointerDown={(e) => startDrag("resize", e)}
              onKeyDown={(event) => {
                const delta =
                  event.key === "ArrowUp" || event.key === "ArrowRight"
                    ? 20
                    : event.key === "ArrowDown" || event.key === "ArrowLeft"
                      ? -20
                      : 0
                if (delta === 0) return
                event.preventDefault()
                const next = clampN(userBox + delta, MIN_SIZE, 2000)
                setUserBox(next)
                setComputerUsePipLayoutPreference({
                  alignment,
                  preferredLongEdge: next,
                })
              }}
              className={cn(
                "absolute z-10 flex size-5 touch-none items-center justify-center rounded-sm text-white/60 outline-none focus-visible:ring-2 focus-visible:ring-primary",
                HANDLE_CORNER[alignment],
                alignment === "bottomRight" || alignment === "topLeft"
                  ? "cursor-nwse-resize"
                  : "cursor-nesw-resize"
              )}
            >
              <Scaling className="size-3" aria-hidden />
            </button>
          )}
        </>
      </motion.div>

      <Dialog open={zoomOpen} onOpenChange={setZoomOpen}>
        <DialogContent
          aria-describedby={undefined}
          className="max-w-4xl p-2"
          overlayClassName={captureSuppressed ? "invisible" : undefined}
          style={{ visibility: captureSuppressed ? "hidden" : undefined }}
          data-computer-use-pip-layer
        >
          <DialogTitle className="sr-only">{t("viewLarger")}</DialogTitle>
          {snapshot.frame ? (
            // eslint-disable-next-line @next/next/no-img-element -- ephemeral native screenshot data URL
            <img
              src={snapshot.frame.src}
              alt={t("screenAlt")}
              className="max-h-[80vh] w-full rounded object-contain"
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  )
}
