"use client"

// What the editor shows for a tab whose file is not UTF-8 text — a real pane,
// not a dead end. `binary` files get a type-aware placeholder (images render
// inline when the transport can read bytes; everything else explains itself
// and stops pretending to be a document). `too-large` files explain the
// ceiling and offer "open anyway", which re-runs the read without it.
//
// `readFileBase64` is a *capability*, not a guarantee: transports that can
// read workspace bytes supply it, older/limited ones don't — the pane then
// shows metadata instead of previewing. That is honest degradation, not a
// stub: the check is whether the host can read bytes, not whether the pane
// bothered to try.

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import {
  FileArchiveIcon,
  FileImageIcon,
  FileQuestionIcon,
  FileWarningIcon,
  MusicIcon,
  VideoIcon,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { cn } from "@/lib/utils"
import type { OpenFile } from "./use-project-editor"

/** Read workspace bytes as base64 — supplied by transports that support it. */
export type ReadFileBase64 = (root: string, relPath: string, maxBytes?: number) => Promise<string>

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "ico"])
const AUDIO_EXTENSIONS = new Set(["mp3", "wav", "flac", "ogg", "m4a", "aac"])
const VIDEO_EXTENSIONS = new Set(["mp4", "mov", "mkv", "avi", "webm", "m4v", "wmv"])
const ARCHIVE_EXTENSIONS = new Set(["zip", "tar", "gz", "tgz", "bz2", "xz", "7z", "rar", "jar"])

/** Previews cap at this size; bigger images still show the metadata pane. */
const IMAGE_PREVIEW_MAX_BYTES = 20 * 1024 * 1024

function extOf(relPath: string): string {
  const name = relPath.split("/").pop() ?? ""
  const dot = name.lastIndexOf(".")
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ""
}

function mimeFor(ext: string): string {
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg"
  if (ext === "ico") return "image/x-icon"
  return `image/${ext}`
}

function formatBytes(size: number | undefined): string {
  if (size === undefined) return ""
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}

interface Props {
  file: OpenFile
  rootPath: string
  /** "Open anyway" for `too-large` files. */
  onOpenAnyway: () => void
  /** Byte reader for image previews — absent on transports without one. */
  readFileBase64?: ReadFileBase64
  density?: "compact" | "touch"
}

export function ProjectFileFallback({
  file,
  rootPath,
  onOpenAnyway,
  readFileBase64,
  density = "compact",
}: Props) {
  const t = useTranslations("projectEditor")
  const ext = extOf(file.relPath)
  const name = file.relPath.split("/").pop() ?? file.relPath
  const isImage = file.blocked === "binary" && IMAGE_EXTENSIONS.has(ext)
  const isAudio = file.blocked === "binary" && AUDIO_EXTENSIONS.has(ext)
  const isVideo = file.blocked === "binary" && VIDEO_EXTENSIONS.has(ext)
  const isArchive = file.blocked === "binary" && ARCHIVE_EXTENSIONS.has(ext)

  const Icon = isImage
    ? FileImageIcon
    : isAudio
      ? MusicIcon
      : isVideo
        ? VideoIcon
        : isArchive
          ? FileArchiveIcon
          : file.blocked === "too-large"
            ? FileWarningIcon
            : FileQuestionIcon

  const canPreview =
    isImage &&
    !!readFileBase64 &&
    !(file.sizeBytes !== undefined && file.sizeBytes > IMAGE_PREVIEW_MAX_BYTES)
  const [preview, setPreview] = useState<
    { status: "loading" } | { status: "ready"; url: string } | { status: "unavailable" }
  >(canPreview ? { status: "loading" } : { status: "unavailable" })

  // Reset when the preview inputs change — render-phase adjustment, the
  // sanctioned alternative to syncing state inside the read effect.
  const previewKey = `${canPreview}|${rootPath}|${file.relPath}|${ext}`
  const [prevPreviewKey, setPrevPreviewKey] = useState(previewKey)
  if (previewKey !== prevPreviewKey) {
    setPrevPreviewKey(previewKey)
    setPreview(canPreview ? { status: "loading" } : { status: "unavailable" })
  }

  useEffect(() => {
    if (!canPreview || !readFileBase64) return
    let cancelled = false
    readFileBase64(rootPath, file.relPath, IMAGE_PREVIEW_MAX_BYTES)
      .then(
        (b64) =>
          !cancelled && setPreview({ status: "ready", url: `data:${mimeFor(ext)};base64,${b64}` })
      )
      .catch(() => !cancelled && setPreview({ status: "unavailable" }))
    return () => {
      cancelled = true
    }
  }, [canPreview, readFileBase64, rootPath, file.relPath, ext])

  return (
    <div
      className="flex h-full min-h-0 flex-1 items-center justify-center overflow-auto p-6"
      data-testid="project-file-fallback"
    >
      <div className="flex max-w-md flex-col items-center gap-3 text-center">
        {preview.status === "ready" ? (
          // eslint-disable-next-line @next/next/no-img-element -- a data: URL of a workspace file, not an optimisable asset
          <img
            src={preview.url}
            alt={name}
            className="max-h-72 max-w-full rounded-md border object-contain shadow-sm"
            data-testid="fallback-image-preview"
          />
        ) : (
          <div
            className={cn(
              "flex size-16 items-center justify-center rounded-2xl bg-muted",
              density === "touch" && "size-20"
            )}
          >
            {preview.status === "loading" ? (
              <Spinner className="size-6" />
            ) : (
              <Icon className="size-7 text-muted-foreground" />
            )}
          </div>
        )}
        <div className="min-w-0">
          <p className="truncate font-mono text-sm font-medium">{name}</p>
          {file.sizeBytes !== undefined ? (
            <p className="mt-0.5 text-xs text-muted-foreground">{formatBytes(file.sizeBytes)}</p>
          ) : null}
        </div>
        <p className="text-sm text-muted-foreground">
          {file.blocked === "too-large"
            ? t("fallback.tooLarge", { size: formatBytes(file.sizeBytes) })
            : preview.status === "ready"
              ? t("fallback.imageDescription")
              : t("fallback.binary")}
        </p>
        {file.blocked === "too-large" ? (
          <Button
            type="button"
            variant="outline"
            size={density === "touch" ? "default" : "sm"}
            className={cn(density === "touch" && "min-h-11")}
            onClick={onOpenAnyway}
            data-testid="fallback-open-anyway"
          >
            {t("fallback.openAnyway")}
          </Button>
        ) : null}
      </div>
    </div>
  )
}
