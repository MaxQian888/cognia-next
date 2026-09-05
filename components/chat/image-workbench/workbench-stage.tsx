"use client"

/**
 * The canvas area: the rendered image, and whatever tool is currently drawn on
 * top of it.
 *
 * The image is laid out with `object-contain`, so what the user points at is
 * not where the pixels are. Every pointer position has to travel through the
 * letterbox offset and the display scale before it means anything in source
 * coordinates. That conversion lives in `lib/images/geometry`, tested on its
 * own, because getting it wrong produces the classic crop bug where the saved
 * region is offset from the one that was drawn.
 */

import { useCallback, useEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"

import { clampCropRect, type CropRect } from "@/lib/images"
import type { MaskStroke, MaskPoint } from "@/lib/images"
import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/utils"

export type StageMode = "view" | "crop" | "brush"

export interface WorkbenchStageProps {
  /** Object URL of the current render. */
  previewUrl: string | null
  /** Object URL of the untouched source, shown while comparing. */
  originalUrl: string | null
  /** Size of the current render in source pixels. */
  size: { width: number; height: number } | null
  zoom: number
  mode: StageMode
  showOriginal: boolean
  /** Live crop rect in source pixels, or null when nothing is selected. */
  cropRect: CropRect | null
  onCropRectChange: (rect: CropRect | null) => void
  brush: { radius: number; hardness: number; mode: "add" | "subtract" }
  strokes: readonly MaskStroke[]
  onStrokesChange: (strokes: MaskStroke[]) => void
  onDoubleClick?: () => void
}

interface DisplayBox {
  /** Viewport coordinates, which is what pointer events report in. */
  left: number
  top: number
  width: number
  height: number
  /**
   * The stage's own viewport origin, captured at measure time.
   *
   * Carried in state rather than re-read from the ref, because overlays
   * position themselves relative to the stage and React forbids reading a ref
   * during render. Measuring happens in a callback, where the ref is fair game.
   */
  stageLeft: number
  stageTop: number
}

/**
 * Where the image actually sits inside its box under `object-contain`.
 *
 * The element's own rect is the container, not the picture: a tall photo in a
 * wide box has empty bars on both sides, and a pointer in a bar is not over any
 * pixel at all.
 */
function containedBox(element: HTMLElement, size: { width: number; height: number }): DisplayBox {
  const rect = element.getBoundingClientRect()
  if (rect.width === 0 || rect.height === 0 || size.width === 0 || size.height === 0) {
    return {
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
      stageLeft: rect.left,
      stageTop: rect.top,
    }
  }
  const scale = Math.min(rect.width / size.width, rect.height / size.height)
  const width = size.width * scale
  const height = size.height * scale
  return {
    left: rect.left + (rect.width - width) / 2,
    top: rect.top + (rect.height - height) / 2,
    width,
    height,
    stageLeft: rect.left,
    stageTop: rect.top,
  }
}

export function WorkbenchStage({
  previewUrl,
  originalUrl,
  size,
  zoom,
  mode,
  showOriginal,
  cropRect,
  onCropRectChange,
  brush,
  strokes,
  onStrokesChange,
  onDoubleClick,
}: WorkbenchStageProps) {
  const t = useTranslations("chat.imageWorkbench")
  const stageRef = useRef<HTMLDivElement | null>(null)
  const dragStartRef = useRef<MaskPoint | null>(null)
  const strokeRef = useRef<MaskStroke | null>(null)
  const [displayBox, setDisplayBox] = useState<DisplayBox | null>(null)

  const measure = useCallback(() => {
    if (!stageRef.current || !size) return null
    const box = containedBox(stageRef.current, size)
    setDisplayBox(box)
    return box
  }, [size])

  useEffect(() => {
    measure()
    if (typeof ResizeObserver === "undefined" || !stageRef.current) return
    const observer = new ResizeObserver(() => measure())
    observer.observe(stageRef.current)
    return () => observer.disconnect()
  }, [measure])

  /** Pointer position in SOURCE pixels, or null when it is off the picture. */
  const toSource = useCallback(
    (event: React.PointerEvent): MaskPoint | null => {
      const box = displayBox ?? measure()
      if (!box || !size || box.width === 0) return null
      const x = ((event.clientX - box.left) / box.width) * size.width
      const y = ((event.clientY - box.top) / box.height) * size.height
      return { x, y }
    },
    [displayBox, measure, size]
  )

  const handlePointerDown = useCallback(
    (event: React.PointerEvent) => {
      if (mode === "view" || !size) return
      const point = toSource(event)
      if (!point) return
      event.currentTarget.setPointerCapture?.(event.pointerId)

      if (mode === "crop") {
        dragStartRef.current = point
        onCropRectChange({ x: point.x, y: point.y, width: 1, height: 1 })
        return
      }
      const stroke: MaskStroke = {
        mode: brush.mode,
        radius: brush.radius,
        hardness: brush.hardness,
        points: [point],
      }
      strokeRef.current = stroke
      onStrokesChange([...strokes, stroke])
    },
    [brush, mode, onCropRectChange, onStrokesChange, size, strokes, toSource]
  )

  const handlePointerMove = useCallback(
    (event: React.PointerEvent) => {
      if (!size) return
      const point = toSource(event)
      if (!point) return

      if (mode === "crop" && dragStartRef.current) {
        const start = dragStartRef.current
        onCropRectChange(
          clampCropRect(
            {
              x: Math.min(start.x, point.x),
              y: Math.min(start.y, point.y),
              width: Math.abs(point.x - start.x),
              height: Math.abs(point.y - start.y),
            },
            size
          )
        )
        return
      }
      if (mode === "brush" && strokeRef.current) {
        // The stroke object is replaced rather than mutated so React sees a new
        // array identity and the overlay repaints as the pointer moves.
        const updated: MaskStroke = {
          ...strokeRef.current,
          points: [...strokeRef.current.points, point],
        }
        strokeRef.current = updated
        onStrokesChange([...strokes.slice(0, -1), updated])
      }
    },
    [mode, onCropRectChange, onStrokesChange, size, strokes, toSource]
  )

  const handlePointerUp = useCallback(() => {
    dragStartRef.current = null
    strokeRef.current = null
  }, [])

  const shownUrl = showOriginal ? (originalUrl ?? previewUrl) : previewUrl

  return (
    <div
      ref={stageRef}
      data-testid="workbench-stage"
      data-mode={mode}
      className={cn(
        "relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-black/95 p-4 sm:p-8",
        mode !== "view" && "cursor-crosshair"
      )}
      style={{ touchAction: mode === "view" ? "pan-x pan-y" : "none" }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onDoubleClick={onDoubleClick}
    >
      {shownUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          data-testid="workbench-preview"
          src={shownUrl}
          alt={showOriginal ? t("compareOriginalAlt") : t("previewAlt")}
          draggable={false}
          className="max-h-full max-w-full select-none object-contain"
          style={{ transform: `scale(${zoom})` }}
        />
      ) : (
        <Skeleton className="absolute inset-8 rounded-xl" />
      )}

      {showOriginal ? (
        <span
          data-testid="workbench-compare-badge"
          className="pointer-events-none absolute left-4 top-4 rounded-pill bg-white/15 px-2 py-1 text-xs text-white"
        >
          {t("compareBadge")}
        </span>
      ) : null}

      {mode === "crop" && cropRect && displayBox && size ? (
        <CropOverlay rect={cropRect} box={displayBox} size={size} />
      ) : null}

      {mode === "brush" && displayBox && size ? (
        <BrushOverlay
          strokes={strokes}
          box={displayBox}
          size={size}
          label={t("selectionOverlayAria")}
        />
      ) : null}
    </div>
  )
}

interface OverlayGeometry {
  box: DisplayBox
  size: { width: number; height: number }
}

/** Overlay coordinates are relative to the stage, not the viewport. */
function overlayOrigin(box: DisplayBox): { x: number; y: number } {
  return { x: box.left - box.stageLeft, y: box.top - box.stageTop }
}

function CropOverlay({ rect, box, size }: OverlayGeometry & { rect: CropRect }) {
  const origin = overlayOrigin(box)
  const scaleX = box.width / Math.max(1, size.width)
  const scaleY = box.height / Math.max(1, size.height)
  return (
    <div
      data-testid="workbench-crop-overlay"
      className="pointer-events-none absolute border-2 border-white/90 shadow-[0_0_0_9999px_rgba(0,0,0,0.5)]"
      style={{
        left: origin.x + rect.x * scaleX,
        top: origin.y + rect.y * scaleY,
        width: rect.width * scaleX,
        height: rect.height * scaleY,
      }}
    />
  )
}

function BrushOverlay({
  strokes,
  box,
  size,
  label,
}: OverlayGeometry & { strokes: readonly MaskStroke[]; label: string }) {
  const origin = overlayOrigin(box)
  const scaleX = box.width / Math.max(1, size.width)
  const scaleY = box.height / Math.max(1, size.height)
  return (
    <svg
      data-testid="workbench-brush-overlay"
      role="img"
      aria-label={label}
      className="pointer-events-none absolute"
      style={{ left: origin.x, top: origin.y, width: box.width, height: box.height }}
    >
      {strokes.map((stroke, index) => (
        <polyline
          key={index}
          points={stroke.points.map((p) => `${p.x * scaleX},${p.y * scaleY}`).join(" ")}
          fill="none"
          // Erasing is drawn as a dark trail so the two brush modes are
          // distinguishable without reading the toolbar.
          stroke={stroke.mode === "add" ? "rgba(255,255,255,0.55)" : "rgba(0,0,0,0.55)"}
          strokeWidth={stroke.radius * 2 * scaleX}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ))}
    </svg>
  )
}
