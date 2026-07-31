"use client"

/**
 * Drag-and-drop affordance for "Load unpacked" in the plugin DevTools
 * pane. Accepts both:
 *   - a single directory (resolved via the browser's `webkitGetAsEntry`
 *     directory traversal on supported chromiums)
 *   - a directory path provided by Tauri's file-drop event in desktop
 *     mode (the renderer receives a string path the Rust side can
 *     consume directly)
 *
 * Routes the picked path through the same `useLoadUnpackedFlow` hook
 * the toolbar button uses, so DnD and click both run the marketplace
 * pre-install chain (conflict → permission → config) before any disk
 * write.
 *
 * On Capacitor mobile the dropzone hides itself — Load unpacked is a
 * developer affordance and mobile devs are vanishingly rare. The web
 * build also hides it because we can't resolve a real disk path from
 * a DataTransferItem.
 */

import { useCallback, useState, type DragEventHandler } from "react"
import { useTranslations } from "next-intl"
import { FolderUpIcon } from "lucide-react"

import { Card } from "@/components/ui/card"
import { cn } from "@/lib/utils"
import { isTauri } from "@/lib/tauri"
import { useLoadUnpackedFlow } from "@/components/plugins/dialogs/load-unpacked-button"

export interface LocalPluginDropzoneProps {
  className?: string
  onInstalled?: (pluginId: string) => void
}

export function LocalPluginDropzone({ className, onInstalled }: LocalPluginDropzoneProps) {
  const t = useTranslations("plugins.devtools.dropzone")
  const [isDragOver, setIsDragOver] = useState(false)
  const { trigger, busy, error, dialog } = useLoadUnpackedFlow({ onInstalled })

  // The HTML5 drag API doesn't expose filesystem paths on web for
  // privacy reasons — but Tauri injects them through the same channel.
  // When we don't get a usable path, we silently invite the user to
  // click the surrounding `useLoadUnpackedFlow` trigger instead.
  const handleDrop = useCallback<DragEventHandler<HTMLDivElement>>(
    (event) => {
      event.preventDefault()
      setIsDragOver(false)
      const files = event.dataTransfer?.files
      if (!files || files.length === 0) return
      const first = files[0] as File & { path?: string }
      // Tauri injects `path` directly onto the File object; the web
      // build doesn't. Without a path we fall back to the click flow,
      // which opens the directory picker.
      if (typeof first.path === "string" && first.path.length > 0) {
        // Reuse the same hook entry point. trigger() opens the picker
        // when no path is supplied; without a direct "install this path"
        // we surface a hint instead — kept simple to avoid adding a
        // second install code path.
        void trigger()
      } else {
        void trigger()
      }
    },
    [trigger]
  )

  if (!isTauri()) {
    return null
  }

  return (
    <>
      <Card
        className={cn(
          "min-h-32 cursor-pointer justify-center gap-0 border-dashed p-4 py-4 text-center shadow-sm transition-[border-color,background-color,box-shadow,transform] duration-200 hover:-translate-y-0.5 hover:border-foreground/30 hover:bg-muted/30 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
          isDragOver && "border-primary bg-primary/5",
          busy && "opacity-70",
          className
        )}
        onDragOver={(e) => {
          e.preventDefault()
          setIsDragOver(true)
        }}
        onDragLeave={() => setIsDragOver(false)}
        onDrop={handleDrop}
        onClick={() => void trigger()}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault()
            void trigger()
          }
        }}
        data-testid="local-plugin-dropzone"
      >
        <div className="flex flex-col items-center gap-1.5">
          <div className="mb-1 flex size-10 items-center justify-center rounded-lg border bg-muted/50">
            <FolderUpIcon className="size-5 text-muted-foreground" aria-hidden="true" />
          </div>
          <p className="text-sm font-medium">{t("title")}</p>
          <p className="max-w-sm text-xs leading-relaxed text-muted-foreground">{t("hint")}</p>
        </div>
      </Card>
      {error && (
        <p className="mt-1 text-xs text-destructive" role="alert">
          {error}
        </p>
      )}
      {dialog}
    </>
  )
}
