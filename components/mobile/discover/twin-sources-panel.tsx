"use client"

/**
 * Mobile Twin Sources panel (Wave 3.2).
 *
 * Lists every TwinSource across every twin (newest-first), plus a fab-style
 * "+" button that opens a sub-menu with three ingest paths:
 *
 *   - Paste text  → native `lib/capacitor/dialog.prompt`
 *   - Capture     → `lib/capacitor/camera.pickPhoto({ source: "camera" })`
 *   - File        → web `<input type="file">`
 *
 * Each path enqueues a `twin_ingest_source` outbound job carrying the raw
 * payload; the desktop runs `lib/twin/ingest/runIngestJob` against it
 * once dispatched.
 */

import { useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import { CameraIcon, ClipboardPasteIcon, FileIcon, PlusIcon } from "lucide-react"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Item, ItemContent, ItemDescription, ItemGroup, ItemTitle } from "@/components/ui/item"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { pickPhoto } from "@/lib/capacitor/camera"
import { prompt as nativePrompt } from "@/lib/capacitor/dialog"
import { enqueue } from "@/lib/db/mobile-outbound-queue"
import { getDb } from "@/lib/db/schema"
import type { TwinSource } from "@/types/twin"
import { cn } from "@/lib/utils"

const STATUS_KEY: Record<TwinSource["status"], string> = {
  pending: "statusQueued",
  parsing: "statusParsing",
  parsed: "statusReady",
  failed: "statusFailed",
  deleted: "statusFailed",
}

export interface TwinSourcesPanelProps {
  /** Defaults to "default" — assumes a single-twin install. */
  twinId?: string
  className?: string
}

export function TwinSourcesPanel({ twinId = "default", className }: TwinSourcesPanelProps) {
  const t = useTranslations("mobile.twinSources")
  const [menuOpen, setMenuOpen] = useState(false)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  const sources =
    useLiveQuery<TwinSource[]>(
      () => getDb().twinSources.orderBy("createdAt").reverse().toArray() as Promise<TwinSource[]>,
      []
    ) ?? []

  const onPaste = async () => {
    setMenuOpen(false)
    const r = await nativePrompt({
      title: t("pasteDialogTitle"),
      message: t("pasteDialogPrompt"),
      placeholder: "...",
    })
    if (r.kind !== "submitted" || r.value.trim() === "") {
      if (r.kind === "cancelled") toast.info(t("pasteCancelled"))
      return
    }
    await enqueue({
      command: "twin_ingest_source",
      payload: { twinId, kind: "document", format: "markdown", text: r.value },
      label: t("pickPaste"),
    })
    toast.success(t("queuedToast"))
  }

  const onCamera = async () => {
    setMenuOpen(false)
    const r = await pickPhoto({ source: "camera", resultType: "base64" })
    if (r.kind !== "captured") {
      if (r.kind === "cancelled") return
      const errorKeyMap: Record<string, string> = {
        permission_denied: "permissionDenied",
        unsupported: "unsupported",
        error: "unknown",
      }
      const errorKey = errorKeyMap[r.kind] ?? "unknown"
      toast.error(t(`cameraError.${errorKey}`))
      return
    }
    await enqueue({
      command: "twin_ingest_source",
      payload: {
        twinId,
        kind: "document",
        format: "image",
        base64: r.base64,
        mime: `image/${r.format}`,
      },
      label: t("pickCamera"),
    })
    toast.success(t("queuedToast"))
  }

  const onFilePicked = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setMenuOpen(false)
    const buf = await file.arrayBuffer()
    const bytes = new Uint8Array(buf)
    let binary = ""
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
    const base64 =
      typeof btoa !== "undefined" ? btoa(binary) : Buffer.from(bytes).toString("base64")
    await enqueue({
      command: "twin_ingest_source",
      payload: {
        twinId,
        kind: "document",
        format: file.name.split(".").pop() ?? "bin",
        filename: file.name,
        mime: file.type,
        base64,
      },
      label: t("pickFile"),
    })
    e.target.value = ""
    toast.success(t("queuedToast"))
  }

  return (
    <div className={cn("flex flex-1 flex-col", className)} data-testid="twin-sources-panel">
      <div className="flex items-center justify-between gap-2 px-1 pb-3">
        <h2 className="text-sm font-medium uppercase text-muted-foreground">{t("title")}</h2>
        <Popover open={menuOpen} onOpenChange={setMenuOpen}>
          <PopoverTrigger asChild>
            <Button type="button" size="sm" data-testid="twin-sources-add">
              <PlusIcon className="size-3.5" aria-hidden="true" />
              <span className="ml-1">{t("addCta")}</span>
            </Button>
          </PopoverTrigger>
          <PopoverContent
            align="end"
            side="bottom"
            role="menu"
            data-testid="twin-sources-menu"
            className="grid w-60 grid-cols-3 gap-2 p-3"
          >
            <Button
              type="button"
              variant="ghost"
              onClick={() => void onPaste()}
              className="touch-target h-auto flex-col items-center gap-1 p-2 text-xs font-normal"
              data-testid="twin-sources-paste"
            >
              <ClipboardPasteIcon />
              <span>{t("pickPaste")}</span>
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => void onCamera()}
              className="touch-target h-auto flex-col items-center gap-1 p-2 text-xs font-normal"
              data-testid="twin-sources-camera"
            >
              <CameraIcon />
              <span>{t("pickCamera")}</span>
            </Button>
            <label
              className="touch-target flex flex-col items-center gap-1 rounded-md p-2 text-xs hover:bg-accent hover:text-accent-foreground active:bg-muted/60"
              data-testid="twin-sources-file"
            >
              <FileIcon className="size-4" />
              <span>{t("pickFile")}</span>
              <input
                ref={fileInputRef}
                type="file"
                className="sr-only"
                onChange={onFilePicked}
                data-testid="twin-sources-file-input"
              />
            </label>
          </PopoverContent>
        </Popover>
      </div>

      {sources.length === 0 ? (
        <p className="px-1 text-sm text-muted-foreground">{t("empty")}</p>
      ) : (
        <ItemGroup className="gap-2">
          {sources.map((src) => (
            <Item
              key={src.id}
              variant="outline"
              size="sm"
              className="bg-card"
              data-testid={`twin-source-${src.id}`}
            >
              <ItemContent>
                <ItemTitle className="flex items-center gap-2 text-sm">
                  <span className="truncate">{src.title}</span>
                  <Badge variant="outline" className="text-[10px]">
                    {t(STATUS_KEY[src.status])}
                  </Badge>
                </ItemTitle>
                <ItemDescription className="text-[11px]">
                  {src.format} · {(src.bytes / 1024).toFixed(1)} KB
                </ItemDescription>
              </ItemContent>
            </Item>
          ))}
        </ItemGroup>
      )}
    </div>
  )
}
