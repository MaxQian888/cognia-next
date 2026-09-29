"use client"

/**
 * Answers the file choosers a local-runtime page opens (ADR-0201).
 *
 * Headless Chromium shows no file dialog: the runtime intercepts it and
 * publishes `filechooser.opened`. A session may only upload from
 * `<app_data>/browser/uploads`, so the pane lets the user pick in a native
 * picker through `localBrowser.stageUpload()` (Rust copies the picked files
 * there) and answers the chooser with the staged paths. A cancelled pick
 * cancels the chooser; a failed one is reported and cancels it too, so the
 * page is never left waiting.
 */

import { useTranslations } from "next-intl"
import { useEffect } from "react"
import { toast } from "sonner"

import { localBrowser, type LocalBrowserEvent } from "@/lib/browser/local-client"

type FileChooserEvent = Extract<LocalBrowserEvent, { type: "filechooser.opened" }>

/** The code the runtime answers with once the chooser is gone (replaced or its page closed). */
const CHOOSER_GONE = "browser_file_chooser_not_found"

function messageOf(error: unknown): string {
  if (typeof error === "string") return error
  if (error instanceof Error) return error.message
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message: unknown }).message)
  }
  return String(error)
}

function basename(path: string): string {
  const parts = path.split(/[\\/]/)
  return parts[parts.length - 1] || path
}

/** Narrow a runtime event to a well-formed `filechooser.opened`. */
export function asFileChooserOpened(event: unknown): FileChooserEvent | null {
  if (!event || typeof event !== "object") return null
  const record = event as Record<string, unknown>
  if (record.type !== "filechooser.opened") return null
  if (typeof record.sessionId !== "string" || typeof record.chooserId !== "string") return null
  if (!record.chooserId) return null
  return {
    type: "filechooser.opened",
    sessionId: record.sessionId,
    pageId: typeof record.pageId === "string" ? record.pageId : "",
    chooserId: record.chooserId,
    multiple: record.multiple === true,
  }
}

/** Mount once per local-runtime pane; `sessionId` is the pane's session. */
export function useLocalFileChooser(sessionId: string | null | undefined): void {
  const t = useTranslations("browserLocal.upload")

  useEffect(() => {
    if (!sessionId) return
    let disposed = false
    let unlisten: (() => void) | null = null
    // One native picker at a time: a chooser opened while one is being
    // answered replaces it in the runtime, and is answered after it.
    let chain: Promise<void> = Promise.resolve()

    const answer = async (chooser: FileChooserEvent) => {
      let paths: string[] = []
      try {
        const staged = await localBrowser.stageUpload()
        paths = chooser.multiple ? staged : staged.slice(0, 1)
        if (!chooser.multiple && staged.length > 1) {
          toast.info(t("singleFile", { name: basename(staged[0]) }))
        }
      } catch (error) {
        toast.error(t("failed", { message: messageOf(error) }))
        paths = []
      }
      if (disposed) return
      try {
        await localBrowser.answerFileChooser(sessionId, chooser.chooserId, paths)
      } catch (error) {
        const message = messageOf(error)
        if (!message.includes(CHOOSER_GONE)) toast.error(t("failed", { message }))
      }
    }

    void localBrowser
      .onEvent((event) => {
        const chooser = asFileChooserOpened(event)
        if (!chooser || chooser.sessionId !== sessionId) return
        chain = chain.then(() => (disposed ? undefined : answer(chooser)))
      })
      .then((stop) => {
        if (disposed) stop()
        else unlisten = stop
      })
      .catch(() => undefined)

    return () => {
      disposed = true
      unlisten?.()
    }
  }, [sessionId, t])
}
