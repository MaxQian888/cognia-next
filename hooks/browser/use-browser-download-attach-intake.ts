"use client"

/**
 * The receiving end of an agent's `browser_download {action: "attach"}`
 * (ADR-0201): `requestBrowserDownloadAttach` dispatches a claimable window
 * event naming a chat; the composer showing THAT chat claims it and stages
 * the file as an ordinary attachment.
 *
 * Staged, not sent: the request arrives mid-turn (the agent is running a tool),
 * and sending would interrupt the very turn that asked. The file goes through
 * the composer's own intake gate (`acceptFiles`: type, size, count), so it is
 * held to exactly the rules of the paperclip, and the user sends it.
 *
 * The bytes come from `readDownload` (`browser_download_read`), which Rust
 * containment-checks and caps at 64 MB (`download_too_large`).
 */

import { useEffect, useRef } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { downloadReadFailure } from "@/hooks/browser/use-browser-downloads"
import { mediaTypeForFilename } from "@/hooks/browser/use-selection-to-chat"
import {
  onBrowserDownloadAttachRequest,
  readDownload,
  type BrowserDownloadAttachRequest,
} from "@/lib/browser/downloads-client"
import { summaryToDownloadUpdate, upsertBrowserDownload } from "@/lib/db/browser-downloads"

export interface UseBrowserDownloadAttachIntakeOptions {
  /** The chat this composer shows; only requests naming it are claimed. */
  sessionId: string | null
  /** The composer's single intake gate; resolves to the files it staged. */
  acceptFiles: (files: File[]) => Promise<File[]>
}

function basename(path: string): string {
  const parts = path.split(/[\\/]/)
  return parts[parts.length - 1] || path
}

export function useBrowserDownloadAttachIntake({
  sessionId,
  acceptFiles,
}: UseBrowserDownloadAttachIntakeOptions): void {
  const t = useTranslations("browserLocal.downloads")
  const acceptRef = useRef(acceptFiles)
  const tRef = useRef(t)
  useEffect(() => {
    acceptRef.current = acceptFiles
    tRef.current = t
  }, [acceptFiles, t])

  useEffect(() => {
    if (!sessionId) return
    const stage = async ({ download }: BrowserDownloadAttachRequest, path: string) => {
      let bytes: Uint8Array
      try {
        bytes = await readDownload(path)
      } catch (error) {
        toast.error(
          downloadReadFailure(error) === "too-large"
            ? tRef.current("tooLarge")
            : tRef.current("attachFailed")
        )
        return
      }
      const filename = download.filename || basename(path)
      const copy = new Uint8Array(bytes.byteLength)
      copy.set(bytes)
      const file = new File([copy.buffer], filename, {
        type: download.mimeType || mediaTypeForFilename(filename),
      })
      const staged = await acceptRef.current([file])
      // A refusal has already been explained by the intake gate's own toast.
      if (staged.length === 0) return
      await upsertBrowserDownload({
        ...summaryToDownloadUpdate(download),
        state: "attached",
      }).catch(() => undefined)
    }
    return onBrowserDownloadAttachRequest((request) => {
      if (request.chatSessionId !== sessionId) return false
      const path = request.download.savedPath
      if (!path) return false
      void stage(request, path)
      return true
    })
  }, [sessionId])
}
