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
import { AnimatePresence, motion, useReducedMotion } from "motion/react"
import { useTranslations } from "next-intl"
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"

import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { desktop } from "@/lib/automation/client"
import {
  beginComputerUsePipRun,
  clearComputerUsePipSession,
  getComputerUsePipLayoutPreference,
  setComputerUsePipAlwaysHidden,
  setComputerUsePipDismissed,
  setComputerUsePipHidden,
  setComputerUsePipLayoutPreference,
  setComputerUsePipRunEnded,
  useComputerUsePip,
  useComputerUsePipAlwaysHidden,
} from "@/lib/automation/computer-use-pip"
import {
  computePictureInPictureAnchors,
  computePictureInPictureSize,
  PICTURE_IN_PICTURE_CHROME_HEIGHT,
  type PictureInPictureAlignment,
  type PictureInPictureMediaSize,
  type PictureInPicturePoint,
  type PictureInPictureRect,
} from "@/lib/automation/picture-in-picture-layout"
import { cn } from "@/lib/utils"
import { useSessionRunId, useSessionStatus } from "@/stores/chat"

const ALIGNMENTS: PictureInPictureAlignment[] = ["bottomRight", "bottomLeft", "topLeft", "topRight"]
const MIN_SIZE = 220
const DEFAULT_BOX = 250
const EDGE = 24
const FRESHNESS_THRESHOLD_S = 5
const TERMINAL_COLLAPSE_MS = 2500
const PILL_SIZE = { width: 190, height: 36 }
const mountedSessionCounts = new Map<string, number>()
const pendingSessionCleanup = new Map<string, ReturnType<typeof setTimeout>>()
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
  const t = useTranslations("automation.pictureInPicture")
  const snapshot = useComputerUsePip(sessionId)
  const hasActivity = snapshot.action != null
  const frameWidth = snapshot.frame?.width
  const frameHeight = snapshot.frame?.height
  const alwaysHidden = useComputerUsePipAlwaysHidden()
  const status = useSessionStatus(sessionId)
  const runId = useSessionRunId(sessionId)
  const busy = status === "streaming" || status === "awaiting_approval"
  const terminalErrored = snapshot.phase === "error" || (snapshot.ended && status === "error")
  const reduce = useReducedMotion()
  const rootRef = useRef<HTMLDivElement>(null)
  const hostRef = useRef<Element | null>(null)
  const dragRef = useRef<DragSession | null>(null)
  const previousSessionIdRef = useRef(sessionId)
  const [alignment, setAlignment] = useState<PictureInPictureAlignment>(
    () => getComputerUsePipLayoutPreference().alignment
  )
  const [point, setPoint] = useState<PictureInPicturePoint | null>(null)
  const [pillPoint, setPillPoint] = useState<PictureInPicturePoint | null>(null)
  const [freePoint, setFreePoint] = useState<PictureInPicturePoint | null>(null)
  const [dims, setDims] = useState<PictureInPictureMediaSize>({
    width: DEFAULT_BOX,
    height: DEFAULT_BOX + PICTURE_IN_PICTURE_CHROME_HEIGHT,
    mediaWidth: DEFAULT_BOX,
    mediaHeight: DEFAULT_BOX,
  })
  const [userBox, setUserBox] = useState(
    () => getComputerUsePipLayoutPreference().preferredLongEdge
  )
  const [preferenceLoaded, setPreferenceLoaded] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [interacting, setInteracting] = useState(false)
  const [zoomOpen, setZoomOpen] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const prevBusyRef = useRef(busy)
  const busySessionIdRef = useRef(sessionId)
  const latestRef = useRef({ point, dims, freePoint, userBox, alignment })

  // Start a move/resize gesture. Reads the current geometry from `latestRef`
  // (kept fresh by the effect below) so the callback can stay stable.
  const startDrag = useCallback((mode: DragMode, e: React.PointerEvent) => {
    if (mode === "move" && (e.target as HTMLElement).closest("button")) return
    e.preventDefault()
    const s = latestRef.current
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
    }
    if (Number.isFinite(e.pointerId)) e.currentTarget.setPointerCapture?.(e.pointerId)
    setDragging(true)
  }, [])

  // Mirror the geometry the pointer handlers need into a ref (read off-render).
  useEffect(() => {
    latestRef.current = { point, dims, freePoint, userBox, alignment }
  })

  useLayoutEffect(() => {
    beginComputerUsePipRun(sessionId, runId)
  }, [runId, sessionId])

  // Keep snapshots across React Strict Mode's synthetic unmount/remount, but
  // release them after a real pane unmount so stale frames cannot reappear.
  useEffect(() => {
    const pending = pendingSessionCleanup.get(sessionId)
    if (pending) {
      clearTimeout(pending)
      pendingSessionCleanup.delete(sessionId)
    }
    mountedSessionCounts.set(sessionId, (mountedSessionCounts.get(sessionId) ?? 0) + 1)
    return () => {
      const remaining = Math.max(0, (mountedSessionCounts.get(sessionId) ?? 1) - 1)
      if (remaining > 0) {
        mountedSessionCounts.set(sessionId, remaining)
        return
      }
      mountedSessionCounts.delete(sessionId)
      const timer = setTimeout(() => {
        pendingSessionCleanup.delete(sessionId)
        if (!mountedSessionCounts.has(sessionId)) clearComputerUsePipSession(sessionId)
      }, 0)
      pendingSessionCleanup.set(sessionId, timer)
    }
  }, [sessionId])

  // Load the global "always hide" preference lazily, on first activity.
  useEffect(() => {
    if (!hasActivity || preferenceLoaded) return
    let cancelled = false
    desktop
      .settingsGet()
      .then((settings) => {
        if (!cancelled) {
          setComputerUsePipAlwaysHidden(settings.alwaysHidePictureInPicture)
          setPreferenceLoaded(true)
        }
      })
      .catch(() => {
        if (!cancelled) setPreferenceLoaded(true)
      })
    return () => {
      cancelled = true
    }
  }, [hasActivity, preferenceLoaded])

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
    if (!snapshot.ended || terminalErrored || interacting || zoomOpen) return
    const id = setTimeout(() => setComputerUsePipHidden(sessionId, true), TERMINAL_COLLAPSE_MS)
    return () => clearTimeout(id)
  }, [snapshot.ended, terminalErrored, interacting, sessionId, zoomOpen])

  // Freshness ticker — the interval mounts only while the run is live, so an idle
  // surface never ticks. Mirrors the run-panel elapsed-time pattern.
  useEffect(() => {
    if (!busy) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [busy])

  // Drop the previous session on an actual prop switch. Avoid an unmount cleanup:
  // React Strict Mode replays effects in development and would otherwise erase
  // activity that arrived just before the surface mounted.
  useEffect(() => {
    const previousSessionId = previousSessionIdRef.current
    previousSessionIdRef.current = sessionId
    if (previousSessionId !== sessionId) {
      clearComputerUsePipSession(previousSessionId)
      dragRef.current = null
      setFreePoint(null)
      setDragging(false)
      setInteracting(false)
      setZoomOpen(false)
    }
  }, [sessionId])

  // Pointer drag/resize — registered once; the handlers no-op unless a drag is
  // active (dragRef). Free-dragging repositions; releasing a move snaps to the
  // nearest corner so obstacle avoidance and the anchor model still apply.
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const drag = dragRef.current
      const host = hostRef.current
      if (!drag || !host) return
      if (drag.pointerId != null && e.pointerId !== drag.pointerId) return
      const rect = rectOf(host)
      const dx = e.clientX - drag.pointerX
      const dy = e.clientY - drag.pointerY
      if (drag.mode === "move") {
        setFreePoint({
          x: clampN(drag.startPoint.x + dx, EDGE, rect.width - drag.startWidth - EDGE),
          y: clampN(drag.startPoint.y + dy, EDGE, rect.height - drag.startHeight - EDGE),
        })
      } else {
        const hostMax = Math.max(
          MIN_SIZE,
          Math.max(rect.width - 2 * EDGE, rect.height - 2 * EDGE - PICTURE_IN_PICTURE_CHROME_HEIGHT)
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

  useLayoutEffect(() => {
    const root = rootRef.current
    const host = root?.parentElement?.closest("[data-computer-use-pip-host]")
    hostRef.current = host ?? null
    if (!root || !host) return

    let resizeObserver: ResizeObserver | null = null
    const update = () => {
      const hostRect = rectOf(host)
      if (hostRect.width <= 0 || hostRect.height <= 0) return
      const ratio = frameWidth && frameHeight ? frameWidth / frameHeight : 1
      const nextDims = computePictureInPictureSize({
        aspectRatio: ratio,
        preferredLongEdge: userBox,
        hostWidth: hostRect.width,
        hostHeight: hostRect.height,
      })
      const obstacleElements = Array.from(host.querySelectorAll("[data-computer-use-pip-obstacle]"))
      for (const obstacle of obstacleElements) resizeObserver?.observe(obstacle)
      const obstacles = obstacleElements.map(rectOf)
      const anchor = computePictureInPictureAnchors(hostRect, obstacles, nextDims)[alignment]
      const pillAnchor = computePictureInPictureAnchors(hostRect, obstacles, PILL_SIZE)[alignment]
      setDims(nextDims)
      setPoint({ x: anchor.x - hostRect.x, y: anchor.y - hostRect.y })
      setPillPoint({ x: pillAnchor.x - hostRect.x, y: pillAnchor.y - hostRect.y })
    }

    resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update)
    resizeObserver?.observe(host)
    update()
    const mutationObserver =
      typeof MutationObserver === "undefined"
        ? null
        : new MutationObserver((mutations) => {
            const obstacleChanged = mutations.some((mutation) =>
              [...mutation.addedNodes, ...mutation.removedNodes].some(
                (node) =>
                  node instanceof Element &&
                  (node.matches("[data-computer-use-pip-obstacle]") ||
                    node.querySelector("[data-computer-use-pip-obstacle]") != null)
              )
            )
            if (obstacleChanged) update()
          })
    mutationObserver?.observe(host, { childList: true, subtree: true })
    window.addEventListener("resize", update)
    document.addEventListener("scroll", update, true)
    return () => {
      resizeObserver?.disconnect()
      mutationObserver?.disconnect()
      window.removeEventListener("resize", update)
      document.removeEventListener("scroll", update, true)
    }
    // `snapshot.action` / `snapshot.hidden` intentionally excluded — per-action
    // updates must not tear down and rebuild the observers.
  }, [alignment, alwaysHidden, preferenceLoaded, frameWidth, frameHeight, userBox])

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
        style={pillPoint ? { left: pillPoint.x, top: pillPoint.y } : { right: EDGE, bottom: EDGE }}
      >
        <motion.div
          initial={reduce ? false : { opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
        >
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="gap-2 shadow-lg"
            aria-label={t("show")}
            onClick={() => setComputerUsePipHidden(sessionId, false)}
          >
            <MonitorPlay className="size-4" aria-hidden />
            {t("show")}
          </Button>
        </motion.div>
      </div>
    )
  }

  const errored = terminalErrored
  const freshness =
    !snapshot.ended && busy && snapshot.frame
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
        aria-label={t("title")}
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
        onFocusCapture={() => setInteracting(true)}
        onBlurCapture={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
            setInteracting(false)
          }
        }}
      >
        <TooltipProvider>
          <div className="flex min-w-0 flex-1 flex-col">
            <div
              className="flex h-9 shrink-0 cursor-grab items-center gap-2 border-b px-2 active:cursor-grabbing"
              onPointerDown={(e) => startDrag("move", e)}
            >
              <MonitorPlay className="size-4 text-primary" aria-hidden />
              <span className="min-w-0 flex-1 truncate text-xs font-medium">{t("title")}</span>
              {snapshot.phase === "running" && !snapshot.ended && (
                <LoaderCircle className="size-3.5 animate-spin text-muted-foreground" aria-hidden />
              )}
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
                <TooltipContent>{t("move")}</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    aria-label={t("hide")}
                    onClick={() => setComputerUsePipHidden(sessionId, true)}
                  >
                    <EyeOff className="size-3.5" aria-hidden />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{t("hide")}</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    aria-label={t("close")}
                    onClick={() => setComputerUsePipDismissed(sessionId, true)}
                  >
                    <X className="size-3.5" aria-hidden />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{t("close")}</TooltipContent>
              </Tooltip>
            </div>
            <div className="relative min-h-0 flex-1 bg-black">
              {snapshot.frame ? (
                <button
                  type="button"
                  aria-label={t("viewLarger")}
                  onClick={() => setZoomOpen(true)}
                  className="group absolute inset-0 cursor-zoom-in"
                >
                  <AnimatePresence initial={false} mode="popLayout">
                    <motion.img
                      key={snapshot.frame.src}
                      src={snapshot.frame.src}
                      alt={t("screenAlt")}
                      className="absolute inset-0 size-full object-contain"
                      initial={reduce ? false : { opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={reduce ? undefined : { opacity: 0 }}
                    />
                  </AnimatePresence>
                  <Maximize2
                    className="absolute right-1.5 top-1.5 size-4 text-white/70 opacity-0 transition-opacity group-hover:opacity-100"
                    aria-hidden
                  />
                </button>
              ) : (
                <div className="flex size-full items-center justify-center text-xs text-white/70">
                  {t("waitingForFrame")}
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
                    t("activity", { action: actionLabel })
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
              "absolute z-10 flex size-5 items-center justify-center rounded-sm text-white/60 outline-none focus-visible:ring-2 focus-visible:ring-primary",
              HANDLE_CORNER[alignment],
              alignment === "bottomRight" || alignment === "topLeft"
                ? "cursor-nwse-resize"
                : "cursor-nesw-resize"
            )}
          >
            <Scaling className="size-3" aria-hidden />
          </button>
        </TooltipProvider>
      </motion.div>

      <Dialog open={zoomOpen} onOpenChange={setZoomOpen}>
        <DialogContent aria-describedby={undefined} className="max-w-4xl p-2">
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
