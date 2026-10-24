"use client"

/**
 * Streamdown renderer for an ```a2ui fence while the turn is still streaming.
 *
 * Without it the fence streamed as a code block, so the user watched raw JSON
 * scroll until the turn sealed and the adapter split the fence into an `a2ui`
 * part. This renderer parses the prefix written so far
 * (`lib/a2ui/streaming-preview.ts`) into a read-only preview surface of its
 * own and draws it with the ordinary A2UI surface, so the layout appears
 * component by component.
 *
 * The preview is a placeholder for the sealed surface, not the surface itself:
 * it is inert (no clicks, no typing, no actions), it never touches the id the
 * model chose, and it is deleted when the sealed message replaces it. Anything
 * typed into it would be lost at that moment, which is why it is inert.
 */

import { useEffect, useId, useRef } from "react"
import { useTranslations } from "next-intl"
import type { CustomRendererProps } from "streamdown"
import { A2UISurface } from "@/components/a2ui/a2ui-surface"
import { Skeleton } from "@/components/ui/skeleton"
import { A2UI_PREVIEW_SURFACE_PREFIX, parseStreamingA2UI } from "@/lib/a2ui/streaming-preview"
import { useA2UIStore } from "@/stores/a2ui"
import type { A2UIServerMessage } from "@/types/a2ui/schema"

/** Parse at most this often; each parse re-reads the whole fence. */
export const A2UI_PREVIEW_THROTTLE_MS = 120

function applyPreview(surfaceId: string, messages: A2UIServerMessage[]): void {
  const store = useA2UIStore.getState()
  // Recreating the surface on every token would wipe what is already drawn;
  // after the first pass only components and data are upserted.
  const exists = Boolean(store.surfaces[surfaceId])
  const pending = exists ? messages.filter((message) => message.type !== "createSurface") : messages
  try {
    store.processMessages(pending)
    // Declarations ride on `createSurface`, which only arrive whole (see
    // `parseStreamingA2UI`); an already drawn preview takes them as an update.
    for (const message of messages) {
      if (exists && message.type === "createSurface" && message.computed) {
        store.setComputedFields(surfaceId, message.computed)
      }
    }
  } catch {
    // A prefix the store rejects keeps the previous preview; the next token
    // (or the sealed message) supersedes it.
  }
  if (useA2UIStore.getState().surfaces[surfaceId]) store.setSurfaceStreaming(surfaceId, true)
}

export function A2UIStreamingPreview({ code }: CustomRendererProps) {
  const t = useTranslations("chat.renderers.a2ui")
  const previewSurfaceId = `${A2UI_PREVIEW_SURFACE_PREFIX}${useId()}`
  const surface = useA2UIStore((state) => state.surfaces[previewSurfaceId])
  const latestCode = useRef(code)
  const lastRunAt = useRef(0)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    latestCode.current = code
    const run = () => {
      timer.current = null
      lastRunAt.current = Date.now()
      // A timer callback is outside the error boundary; a prefix that cannot
      // be previewed just leaves the previous frame for the next token.
      try {
        const preview = parseStreamingA2UI(latestCode.current, previewSurfaceId)
        if (preview) applyPreview(previewSurfaceId, preview.messages)
      } catch {
        // Nothing to draw yet.
      }
    }
    if (timer.current) return
    const wait = A2UI_PREVIEW_THROTTLE_MS - (Date.now() - lastRunAt.current)
    if (wait <= 0) run()
    else timer.current = setTimeout(run, wait)
  }, [code, previewSurfaceId])

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
      // Cleared so a cleanup without an unmount (Activity, Fast Refresh) does
      // not leave the throttle waiting on a timer that will never fire.
      timer.current = null
      useA2UIStore.getState().deleteSurface(previewSurfaceId)
    },
    [previewSurfaceId]
  )

  if (!surface?.ready) {
    return (
      <div
        role="status"
        aria-busy
        aria-label={t("generating")}
        data-a2ui-preview="pending"
        className="my-2 space-y-2 rounded-lg border bg-card p-3"
      >
        <span className="text-muted-foreground text-xs">{t("generating")}</span>
        <Skeleton className="h-16 w-full" />
      </div>
    )
  }

  return (
    // `inert` also hides the half-built controls from assistive tech, so the
    // label and busy state sit on a wrapper outside it.
    <div className="my-2" role="region" aria-busy aria-label={t("label")}>
      <div data-a2ui-preview="live" inert>
        <A2UISurface
          surfaceId={previewSurfaceId}
          className="rounded-lg border bg-card p-3"
          showLoading={false}
          readOnly
        />
      </div>
    </div>
  )
}
