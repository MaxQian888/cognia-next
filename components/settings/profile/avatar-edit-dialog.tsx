"use client"

/**
 * Avatar crop/zoom editor shown after a file is picked in
 * `ProfileAvatarPicker`. Lets the user pan (drag) and zoom a square viewport
 * over the source image, then re-encodes the chosen region through
 * `lib/profile/avatar-image.ts:encodeAvatarRegion` — the SAME size-capped
 * encoder the forced-center-crop path uses, so the 96 KB sync/backup contract
 * is preserved. The viewport is a fixed display square; all crop math is done
 * in source pixels so it is independent of the rendered size.
 *
 * The editor is split from the dialog shell so it remounts per picked file
 * (keyed below): pan/zoom state resets for free and the preview object URL is
 * created once via a lazy initializer — no setState-in-effect.
 */

import { useCallback, useEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { Loader2Icon, ZoomInIcon, ZoomOutIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Slider } from "@/components/ui/slider"
import { encodeAvatarRegion } from "@/lib/profile/avatar-image"
import { cn } from "@/lib/utils"

/** Display size of the square crop viewport, in CSS pixels. */
export const VIEWPORT_PX = 256
/** Zoom bounds for the slider; 1 = the smallest scale that covers the viewport. */
export const MIN_ZOOM = 1
export const MAX_ZOOM = 4
const ZOOM_STEP = 0.01

interface Offset {
  x: number
  y: number
}

/** Clamp the image top-left offset so the viewport stays fully covered. */
function clampOffset(offset: Offset, displayedW: number, displayedH: number): Offset {
  return {
    x: Math.min(0, Math.max(VIEWPORT_PX - displayedW, offset.x)),
    y: Math.min(0, Math.max(VIEWPORT_PX - displayedH, offset.y)),
  }
}

export interface AvatarEditDialogProps {
  /** The picked file. When non-null the dialog is open; null closes it. */
  file: File | null
  onCancel: () => void
  /** Receives the cropped, size-capped `data:` URL. */
  onConfirm: (dataUrl: string) => void | Promise<void>
}

export function AvatarEditDialog({ file, onCancel, onConfirm }: AvatarEditDialogProps) {
  const t = useTranslations("settings.profile")
  // The async tail of saving (the parent persist) lives here so the dialog
  // shell can block close while it is in flight; the editor reflects it.
  const [saving, setSaving] = useState(false)

  const handleConfirm = useCallback(
    async (dataUrl: string) => {
      setSaving(true)
      try {
        await onConfirm(dataUrl)
      } finally {
        setSaving(false)
      }
    },
    [onConfirm]
  )

  return (
    <Dialog open={file != null} onOpenChange={(open) => !open && !saving && onCancel()}>
      <DialogContent className="sm:max-w-md" data-testid="avatar-edit-dialog">
        <DialogHeader>
          <DialogTitle>{t("avatarEditTitle")}</DialogTitle>
          <DialogDescription>{t("avatarEditDescription")}</DialogDescription>
        </DialogHeader>
        {file ? (
          <AvatarCropEditor
            key={`${file.name}:${file.size}:${file.lastModified}`}
            file={file}
            saving={saving}
            onCancel={onCancel}
            onConfirm={handleConfirm}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

interface AvatarCropEditorProps {
  file: File
  saving: boolean
  onCancel: () => void
  onConfirm: (dataUrl: string) => void | Promise<void>
}

function AvatarCropEditor({ file, saving, onCancel, onConfirm }: AvatarCropEditorProps) {
  const t = useTranslations("settings.profile")
  const tc = useTranslations("common")

  const imgRef = useRef<HTMLImageElement | null>(null)
  const dragRef = useRef<{ pointerX: number; pointerY: number; offset: Offset } | null>(null)

  // Created once per mount (this component is keyed by file), revoked on unmount.
  const [objectUrl] = useState(() => URL.createObjectURL(file))
  useEffect(() => () => URL.revokeObjectURL(objectUrl), [objectUrl])

  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null)
  const [zoom, setZoom] = useState(MIN_ZOOM)
  const [offset, setOffset] = useState<Offset>({ x: 0, y: 0 })

  const baseScale = natural ? VIEWPORT_PX / Math.min(natural.w, natural.h) : 1
  const scale = baseScale * zoom
  const displayedW = natural ? natural.w * scale : 0
  const displayedH = natural ? natural.h * scale : 0

  const onImageLoad = useCallback(
    (e: React.SyntheticEvent<HTMLImageElement>) => {
      const el = e.currentTarget
      const w = el.naturalWidth
      const h = el.naturalHeight
      if (!w || !h) {
        toast.error(t("avatarProcessFailed"))
        onCancel()
        return
      }
      setNatural({ w, h })
      // Center the image in the viewport at zoom 1.
      const base = VIEWPORT_PX / Math.min(w, h)
      setOffset({ x: (VIEWPORT_PX - w * base) / 2, y: (VIEWPORT_PX - h * base) / 2 })
    },
    [onCancel, t]
  )

  // Zoom around the viewport center so the framed subject stays put.
  const applyZoom = useCallback(
    (next: number) => {
      const clampedZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next))
      setZoom(clampedZoom)
      if (!natural) return
      const oldScale = baseScale * zoom
      const newScale = baseScale * clampedZoom
      // Source pixel currently under the viewport center.
      const cx = (VIEWPORT_PX / 2 - offset.x) / oldScale
      const cy = (VIEWPORT_PX / 2 - offset.y) / oldScale
      const nextOffset = {
        x: VIEWPORT_PX / 2 - cx * newScale,
        y: VIEWPORT_PX / 2 - cy * newScale,
      }
      setOffset(clampOffset(nextOffset, natural.w * newScale, natural.h * newScale))
    },
    [baseScale, natural, offset.x, offset.y, zoom]
  )

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!natural) return
      e.currentTarget.setPointerCapture?.(e.pointerId)
      dragRef.current = { pointerX: e.clientX, pointerY: e.clientY, offset }
    },
    [natural, offset]
  )

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current
      if (!drag || !natural) return
      const next = {
        x: drag.offset.x + (e.clientX - drag.pointerX),
        y: drag.offset.y + (e.clientY - drag.pointerY),
      }
      setOffset(clampOffset(next, natural.w * scale, natural.h * scale))
    },
    [natural, scale]
  )

  const endDrag = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.currentTarget.releasePointerCapture?.(e.pointerId)
    dragRef.current = null
  }, [])

  const handleSave = useCallback(async () => {
    const img = imgRef.current
    if (!img || !natural) return
    // Map the viewport (display space) back to a square region in source px.
    const size = VIEWPORT_PX / scale
    const sx = Math.min(natural.w - size, Math.max(0, -offset.x / scale))
    const sy = Math.min(natural.h - size, Math.max(0, -offset.y / scale))
    try {
      const dataUrl = encodeAvatarRegion(img, { sx, sy, size })
      await onConfirm(dataUrl)
    } catch {
      toast.error(t("avatarProcessFailed"))
    }
  }, [natural, offset.x, offset.y, onConfirm, scale, t])

  return (
    <>
      <div className="flex flex-col items-center gap-4">
        <div
          role="application"
          aria-label={t("avatarEditReposition")}
          className={cn(
            "relative overflow-hidden rounded-md border bg-muted",
            natural ? "cursor-grab touch-none active:cursor-grabbing" : "cursor-default"
          )}
          style={{ width: VIEWPORT_PX, height: VIEWPORT_PX }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          data-testid="avatar-edit-viewport"
        >
          {/* eslint-disable-next-line @next/next/no-img-element -- local object URL, not an optimizable remote asset */}
          <img
            ref={imgRef}
            src={objectUrl}
            alt={t("avatarEditAlt")}
            draggable={false}
            onLoad={onImageLoad}
            className="max-w-none pointer-events-none select-none"
            style={{
              position: "absolute",
              left: offset.x,
              top: offset.y,
              width: displayedW || undefined,
              height: displayedH || undefined,
            }}
            data-testid="avatar-edit-image"
          />
          {/* Circular mask preview — shows the avatar's final round shape. */}
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 rounded-md shadow-[0_0_0_9999px_rgba(0,0,0,0.45)] [clip-path:circle(50%)]"
          />
        </div>

        <div className="flex w-full items-center gap-3" data-testid="avatar-edit-zoom-row">
          <ZoomOutIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <Slider
            value={[zoom]}
            min={MIN_ZOOM}
            max={MAX_ZOOM}
            step={ZOOM_STEP}
            disabled={!natural || saving}
            onValueChange={(v) => applyZoom(v[0] ?? MIN_ZOOM)}
            aria-label={t("avatarEditZoom")}
            data-testid="avatar-edit-zoom"
          />
          <ZoomInIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        </div>
      </div>

      <DialogFooter>
        <Button
          type="button"
          variant="outline"
          onClick={onCancel}
          disabled={saving}
          data-testid="avatar-edit-cancel"
        >
          {tc("cancel")}
        </Button>
        <Button
          type="button"
          onClick={() => void handleSave()}
          disabled={!natural || saving}
          data-testid="avatar-edit-save"
        >
          {saving ? <Loader2Icon className="size-4 animate-spin" /> : null}
          {tc("save")}
        </Button>
      </DialogFooter>
    </>
  )
}
