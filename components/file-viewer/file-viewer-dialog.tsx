"use client"

/**
 * Read-only file viewer for path links in the terminal and in chat.
 *
 * Reached only when `openInProjectEditor` declines — a live editor rooted at
 * the file always wins, because an editable buffer beats a read-only copy of
 * the same thing.
 *
 * The dialog is chrome; everything about loading and rendering belongs to
 * `FilePreviewSurface`. It is mounted once at the app shell rather than inside
 * the terminal dock, which is what fixes the long-standing bug where clicking a
 * file reference in chat did nothing at all whenever the terminal panel
 * happened to be closed.
 */

import { useTranslations } from "next-intl"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { FilePreviewSurface } from "@/components/file-viewer/file-preview-surface"
import { MAX_VIEWER_BYTES } from "@/lib/file-viewer/probe"
import { fileViewerErrorMessageKey } from "@/lib/file-viewer/types"
import { useFileViewerStore } from "@/stores/file-viewer/file-viewer-store"

export function FileViewerDialog() {
  const t = useTranslations("terminal.fileViewer")
  const tViewer = useTranslations("fileViewer")
  const open = useFileViewerStore((state) => state.open)
  const request = useFileViewerStore((state) => state.request)
  const failure = useFileViewerStore((state) => state.failure)
  const close = useFileViewerStore((state) => state.close)

  const displayName = request?.displayName ?? failure?.displayName ?? null
  const locationSuffix =
    request?.line != null
      ? `:${request.line}${request.column != null ? `:${request.column}` : ""}`
      : ""

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close()
      }}
    >
      <DialogContent
        className="flex h-[80vh] max-w-4xl flex-col gap-0 p-0"
        data-testid="terminal-file-viewer"
      >
        <DialogHeader className="border-b px-4 py-3">
          <DialogTitle className="truncate font-mono text-sm" title={displayName ?? undefined}>
            {displayName ? `${displayName}${locationSuffix}` : t("title")}
          </DialogTitle>
          <DialogDescription className="sr-only">{t("description")}</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1">
          {failure ? (
            <p
              className="p-4 text-sm text-destructive"
              data-testid="file-preview-error"
              data-error-code={failure.code}
            >
              {tViewer(fileViewerErrorMessageKey(failure.code), {
                limit: `${MAX_VIEWER_BYTES / (1024 * 1024)} MB`,
              })}
            </p>
          ) : (
            <FilePreviewSurface request={request} />
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

export default FileViewerDialog
