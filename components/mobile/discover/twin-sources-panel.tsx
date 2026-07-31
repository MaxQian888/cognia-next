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
import {
  CameraIcon,
  ClipboardPasteIcon,
  FileIcon,
  PencilIcon,
  PlusIcon,
  Trash2Icon,
} from "lucide-react"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Item, ItemContent, ItemDescription, ItemGroup, ItemTitle } from "@/components/ui/item"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { LongPress } from "@/components/interactions/long-press"
import { RedactReviewSheet } from "@/components/mobile/discover/redact-review-sheet"
import { pickPhoto } from "@/lib/capacitor/camera"
import { prompt as nativePrompt } from "@/lib/capacitor/dialog"
import { enqueue } from "@/lib/db/mobile-outbound-queue"
import { getDb } from "@/lib/db/schema"
import { deleteTwinSource, updateTwinSource } from "@/lib/db/twin-sources"
import { hasNoLeakingPii } from "@cognia/redact"
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
  /** Text awaiting PII review before it is enqueued. */
  const [redactPending, setRedactPending] = useState<{ text: string; label: string } | null>(null)
  /** Source row whose edit action sheet is open (long-press). */
  const [editingSource, setEditingSource] = useState<TwinSource | null>(null)

  const sources =
    useLiveQuery<TwinSource[]>(
      () => getDb().twinSources.orderBy("createdAt").reverse().toArray() as Promise<TwinSource[]>,
      []
    ) ?? []

  /** Enqueue a markdown text ingest for the desktop to parse + embed. */
  const enqueueText = async (text: string, label: string) => {
    await enqueue({
      command: "twin_ingest_source",
      payload: { twinId, kind: "document", format: "markdown", text },
      label,
    })
    toast.success(t("queuedToast"))
  }

  /**
   * Gate any text ingest path through the shared PII detector. Clean text is
   * enqueued immediately; text carrying detectable PII opens the redact-review
   * sheet so the user confirms what leaves the device. (The desktop ingest job
   * redacts again server-side — this is the on-device preview of that gate.)
   */
  const gateText = (text: string, label: string) => {
    if (hasNoLeakingPii(text)) {
      void enqueueText(text, label)
    } else {
      setRedactPending({ text, label })
    }
  }

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
    gateText(r.value, t("pickPaste"))
  }

  const onRetitle = async (src: TwinSource) => {
    setEditingSource(null)
    const r = await nativePrompt({
      title: t("retitleTitle"),
      message: t("retitlePrompt"),
      placeholder: src.title,
    })
    if (r.kind !== "submitted" || r.value.trim() === "") return
    await updateTwinSource(src.id, { title: r.value.trim() })
    toast.success(t("retitleDone"))
  }

  const onDelete = async (src: TwinSource) => {
    setEditingSource(null)
    await deleteTwinSource(src.id)
    toast.success(t("deleteDone"))
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
            className="grid w-[min(15rem,calc(100vw-2rem))] grid-cols-3 gap-2 p-3"
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
            <LongPress
              key={src.id}
              onLongPress={() => setEditingSource(src)}
              className="block"
            >
              <Item
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
            </LongPress>
          ))}
        </ItemGroup>
      )}

      {/* PII review before any text ingest leaves the device. */}
      {redactPending ? (
        <RedactReviewSheet
          open={redactPending !== null}
          onOpenChange={(open) => {
            if (!open) setRedactPending(null)
          }}
          text={redactPending.text}
          onConfirm={(chosen) => enqueueText(chosen, redactPending.label)}
        />
      ) : null}

      {/* Long-press source editor: retitle / delete. */}
      <Sheet
        open={editingSource !== null}
        onOpenChange={(open) => {
          if (!open) setEditingSource(null)
        }}
      >
        <SheetContent side="bottom" data-testid="twin-source-edit-sheet">
          <SheetHeader>
            <SheetTitle className="truncate">{editingSource?.title}</SheetTitle>
            <SheetDescription>{t("editSheetDescription")}</SheetDescription>
          </SheetHeader>
          <div className="flex flex-col gap-2 p-4">
            <Button
              variant="outline"
              onClick={() => editingSource && void onRetitle(editingSource)}
              data-testid="twin-source-retitle"
            >
              <PencilIcon className="size-4" />
              {t("retitleCta")}
            </Button>
            <Button
              variant="outline"
              onClick={() => editingSource && void onDelete(editingSource)}
              className="border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
              data-testid="twin-source-delete"
            >
              <Trash2Icon className="size-4" />
              {t("deleteCta")}
            </Button>
          </div>
        </SheetContent>
      </Sheet>
    </div>
  )
}
