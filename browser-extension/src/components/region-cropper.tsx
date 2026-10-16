import { useRef, useState, type PointerEvent } from "react"
import { Button } from "@cognia/plugin-ui"

import type { BrowserApi } from "@ext/src/lib/browser-api"
import { regionInImagePixels } from "@ext/src/lib/panel/screenshots"

export interface RegionCropperProps {
  api: BrowserApi
  /** The visible-area capture, as a data URL. */
  src: string
  onCancel: () => void
  /** The chosen rectangle, in the capture's own pixels. */
  onConfirm: (rect: { x: number; y: number; width: number; height: number }) => void
}

type Drag = { x: number; y: number; width: number; height: number }

/**
 * Pick a region of a visible-area screenshot by dragging over it (ADR-0228 §3).
 *
 * The drag is measured on the scaled-down preview and mapped to the capture's
 * own pixels, so the crop is exact at any panel width and device pixel ratio.
 * Someone not using a pointer gets the whole capture by confirming without a drag.
 */
export function RegionCropper({ api, src, onCancel, onConfirm }: RegionCropperProps) {
  const imageRef = useRef<HTMLImageElement | null>(null)
  const [drag, setDrag] = useState<Drag | null>(null)
  const [dragging, setDragging] = useState(false)

  const point = (event: PointerEvent<HTMLDivElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect()
    return {
      x: Math.min(Math.max(0, event.clientX - bounds.left), bounds.width),
      y: Math.min(Math.max(0, event.clientY - bounds.top), bounds.height),
    }
  }

  const confirm = () => {
    const image = imageRef.current
    if (!image) return
    const natural = { width: image.naturalWidth || 1, height: image.naturalHeight || 1 }
    const shown = {
      width: image.clientWidth || natural.width,
      height: image.clientHeight || natural.height,
    }
    const chosen = drag && Math.abs(drag.width) >= 4 && Math.abs(drag.height) >= 4 ? drag : null
    onConfirm(
      chosen
        ? regionInImagePixels(chosen, shown, natural)
        : { x: 0, y: 0, width: natural.width, height: natural.height }
    )
  }

  const box = drag
    ? {
        left: Math.min(drag.x, drag.x + drag.width),
        top: Math.min(drag.y, drag.y + drag.height),
        width: Math.abs(drag.width),
        height: Math.abs(drag.height),
      }
    : null

  return (
    <div className="space-y-2" data-testid="region-cropper">
      <p className="text-[11px] text-muted-foreground">{api.message("attachRegionHint")}</p>
      <div
        className="relative cursor-crosshair touch-none select-none overflow-hidden rounded-control border border-border"
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture?.(event.pointerId)
          const start = point(event)
          setDrag({ ...start, width: 0, height: 0 })
          setDragging(true)
        }}
        onPointerMove={(event) => {
          if (!dragging) return
          const current = point(event)
          setDrag((previous) =>
            previous
              ? { ...previous, width: current.x - previous.x, height: current.y - previous.y }
              : previous
          )
        }}
        onPointerUp={() => setDragging(false)}
        data-testid="region-surface"
      >
        {/* eslint-disable-next-line @next/next/no-img-element -- an extension page; next/image does not exist here */}
        <img
          ref={imageRef}
          src={src}
          alt={api.message("attachRegionAlt")}
          className="block w-full"
          draggable={false}
        />
        {box ? (
          <div
            className="pointer-events-none absolute border-2 border-primary bg-primary/10"
            style={{ left: box.left, top: box.top, width: box.width, height: box.height }}
            data-testid="region-box"
          />
        ) : null}
      </div>
      <div className="flex gap-2">
        <Button size="sm" onClick={confirm} data-testid="region-confirm">
          {api.message("attachRegionConfirm")}
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel} data-testid="region-cancel">
          {api.message("cancel")}
        </Button>
      </div>
    </div>
  )
}
