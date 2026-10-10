"use client"

/**
 * Drop files from the system onto the Files page to upload them (ADR-0223).
 * Directories are walked by the composer's own `collectDroppedFiles`, with the
 * same cap; while a folder is in view the uploads are filed in it. Dragging
 * items inside the page is dnd-kit's pointer drag, not HTML drag and drop, so
 * the two never meet.
 */

import { useRef, useState, type ReactNode } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { UploadIcon } from "lucide-react"

import type { FilesActions } from "@/hooks/files-library/use-files-actions"
import { collectDroppedFiles, MAX_DROPPED_DIR_FILES } from "@/lib/chat/drop-entries"
import { ROOT_LIBRARY_FOLDER_ID } from "@/lib/db/files-library-types"
import { cn } from "@/lib/utils"
import { useFilesLibraryStore } from "@/stores/files-library"

/** A drag that carries files from outside the page. */
export function carriesFiles(dataTransfer: Pick<DataTransfer, "types"> | null): boolean {
  return Boolean(dataTransfer && Array.from(dataTransfer.types).includes("Files"))
}

export function FilesDropZone({
  actions,
  disabled = false,
  className,
  children,
}: {
  actions: Pick<FilesActions, "upload">
  /** The Trash takes no uploads. */
  disabled?: boolean
  className?: string
  children: ReactNode
}) {
  const t = useTranslations("files")
  const [over, setOver] = useState(false)
  // dragenter/dragleave fire for every child crossed; count them.
  const depth = useRef(0)

  const reset = () => {
    depth.current = 0
    setOver(false)
  }

  return (
    <div
      className={cn("relative", className)}
      data-testid="files-drop-zone"
      data-drop-over={over || undefined}
      onDragEnter={(event) => {
        if (disabled || !carriesFiles(event.dataTransfer)) return
        event.preventDefault()
        depth.current += 1
        setOver(true)
      }}
      onDragOver={(event) => {
        if (disabled || !carriesFiles(event.dataTransfer)) return
        event.preventDefault()
        event.dataTransfer.dropEffect = "copy"
      }}
      onDragLeave={(event) => {
        if (disabled || !carriesFiles(event.dataTransfer)) return
        depth.current = Math.max(0, depth.current - 1)
        if (depth.current === 0) setOver(false)
      }}
      onDrop={(event) => {
        if (disabled || !carriesFiles(event.dataTransfer)) return
        event.preventDefault()
        reset()
        const section = useFilesLibraryStore.getState().section
        const folderId =
          section.kind === "folder" && section.folderId !== ROOT_LIBRARY_FOLDER_ID
            ? section.folderId
            : undefined
        void collectDroppedFiles(event.dataTransfer).then(({ files, truncated }) => {
          if (truncated) toast.warning(t("toasts.dropTruncated", { count: MAX_DROPPED_DIR_FILES }))
          return actions.upload(files, folderId)
        })
      }}
    >
      {children}
      {over ? (
        <div
          className="pointer-events-none absolute inset-2 z-20 flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-primary/60 bg-background/80 text-sm font-medium backdrop-blur-sm"
          data-testid="files-drop-overlay"
        >
          <UploadIcon className="size-6 text-primary" aria-hidden />
          {t("dropZone.hint")}
        </div>
      ) : null}
    </div>
  )
}
