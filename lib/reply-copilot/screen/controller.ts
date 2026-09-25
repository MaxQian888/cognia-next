/**
 * Main-window half of the desktop chat copilot (ADR-0194 §8): one run at a
 * time, from the shortcut to candidates in the overlay.
 *
 * Order matters. The capture pins the frontmost window before anything else
 * happens, so the overlay is NOT opened up front: it opens when the capture
 * asks for consent (the pin has happened by then) or when the capture comes
 * back. Its consent prompt is answered here, on the overlay's behalf, and the
 * main window's own consent overlay stands back for the copilot's surface
 * while a run holds the claim. If the overlay cannot open, the claim is
 * released and the prompt shows in the main window instead of nowhere.
 */

import type { AppSettings } from "@cognia/agent-config-types"
import type { ConsentPromptPayload, ConsentRequestEvent } from "@/lib/automation/client"
import type { CopilotResult } from "../run-copilot"
import type {
  ChatCopilotIntent,
  ChatCopilotView,
  ChatCopilotViewError,
  ScreenReadSummary,
} from "./overlay-client"
import {
  ScreenCopilotError,
  type ScreenAnchor,
  type ScreenPhase,
  type ScreenRead,
} from "./run-screen-copilot"

export interface ScreenCopilotControllerDeps {
  settings: () => AppSettings | null | undefined
  read: (
    settings: AppSettings | null | undefined,
    options: { signal?: AbortSignal; onPhase?: (phase: ScreenPhase, anchor?: ScreenAnchor) => void }
  ) => Promise<ScreenRead>
  draft: (
    read: ScreenRead,
    settings: AppSettings | null | undefined,
    options: { instructions?: string; signal?: AbortSignal }
  ) => Promise<CopilotResult>
  overlay: {
    open: (anchor: ScreenAnchor | null) => Promise<boolean>
    place: (anchor: ScreenAnchor) => Promise<void>
    close: () => Promise<void>
    send: (view: ChatCopilotView) => Promise<boolean>
  }
  consent: {
    subscribe: (handler: (event: ConsentRequestEvent) => void) => () => void
    respond: (args: {
      id: string
      allow: boolean
      persist?: boolean
      prompt?: ConsentPromptPayload
      grantDurationMs?: number
    }) => Promise<void>
    promptOf: (event: ConsentRequestEvent) => ConsentPromptPayload
    claim: () => () => void
    settle: (id: string) => void
  }
  openScreenRecordingSettings: () => Promise<void>
  /** The overlay could not open; tell the user from the main window. */
  onOverlayUnavailable: () => void
  now: () => number
}

export interface ScreenCopilotController {
  start: () => Promise<void>
  handleIntent: (intent: ChatCopilotIntent) => Promise<void>
  dispose: () => void
}

function summarize(read: ScreenRead): ScreenReadSummary {
  return {
    appName: read.app.name,
    windowTitle: read.app.windowTitle,
    bubbleCount: read.bubbleCount,
    unsidedReason: read.unsidedReason,
    contact: read.contact,
  }
}

function isAbort(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted || (error instanceof DOMException && error.name === "AbortError")
}

export function createScreenCopilotController(
  deps: ScreenCopilotControllerDeps
): ScreenCopilotController {
  let runId = 0
  let view: ChatCopilotView | null = null
  let read: ScreenRead | null = null
  let run: AbortController | null = null
  let pendingConsent: ConsentRequestEvent | null = null
  let overlayOpen = false
  let releaseClaim: (() => void) | null = null

  function publish(next: ChatCopilotView): void {
    view = next
    if (overlayOpen) void deps.overlay.send(next)
  }

  function release(): void {
    releaseClaim?.()
    releaseClaim = null
  }

  let opening: Promise<boolean> | null = null

  /** Open once, even when a prompt and a finished capture race to open it. */
  async function ensureOverlay(anchor: ScreenAnchor | null): Promise<boolean> {
    if (!overlayOpen && opening) {
      if (!(await opening)) return false
    }
    if (overlayOpen) {
      if (anchor) await deps.overlay.place(anchor)
      return true
    }
    opening = deps.overlay
      .open(anchor)
      .then((open) => {
        if (open) {
          overlayOpen = true
        } else {
          // Nobody can answer in the overlay: hand prompts back to the main window.
          release()
          deps.onOverlayUnavailable()
        }
        return open
      })
      .finally(() => {
        opening = null
      })
    return opening
  }

  /** Reject a prompt nobody will answer now, rather than let it time out. */
  async function dropPendingConsent(): Promise<void> {
    const pending = pendingConsent
    pendingConsent = null
    if (!pending) return
    deps.consent.settle(pending.id)
    await deps.consent.respond({ id: pending.id, allow: false }).catch(() => undefined)
  }

  async function cancelRun(): Promise<void> {
    run?.abort()
    run = null
    await dropPendingConsent()
  }

  const unsubscribeConsent = deps.consent.subscribe((event) => {
    if (event.surface !== "chatCopilot" || !run) return
    const id = runId
    pendingConsent = event
    void ensureOverlay(null).then((open) => {
      if (!open || id !== runId || pendingConsent?.id !== event.id) return
      publish({
        phase: "consent",
        runId: id,
        consent: {
          id: event.id,
          processName: event.processName,
          windowTitle: event.windowTitle,
          expiresAt: deps.now() + event.timeoutMs,
        },
      })
    })
  })

  async function draft(id: number, current: ScreenRead, instructions: string): Promise<void> {
    const controller = new AbortController()
    run?.abort()
    run = controller
    const settings = deps.settings()
    publish({ phase: "thinking", runId: id, read: summarize(current), instructions })
    try {
      const result = await deps.draft(current, settings, {
        instructions,
        signal: controller.signal,
      })
      if (id !== runId || controller.signal.aborted) return
      publish({
        phase: "done",
        runId: id,
        read: summarize(current),
        result,
        knowledge: current.knowledge,
        instructions,
      })
    } catch (error) {
      if (id !== runId || isAbort(error, controller.signal)) return
      publish({
        phase: "error",
        runId: id,
        error: "draft_failed",
        read: summarize(current),
        instructions,
      })
    } finally {
      if (run === controller) run = null
    }
  }

  async function start(): Promise<void> {
    await cancelRun()
    const id = ++runId
    read = null
    view = { phase: "capturing", runId: id }
    if (overlayOpen) publish(view)
    // Claim before capturing so the main window never flashes this prompt.
    releaseClaim ??= deps.consent.claim()
    const controller = new AbortController()
    run = controller
    const settings = deps.settings()
    let current: ScreenRead
    try {
      current = await deps.read(settings, {
        signal: controller.signal,
        onPhase: (phase, anchor) => {
          if (id !== runId || phase !== "reading") return
          pendingConsent = null
          void ensureOverlay(anchor ?? null).then((open) => {
            // Only step forward: a fast read may already be drafting.
            if (
              open &&
              id === runId &&
              (view?.phase === "capturing" || view?.phase === "consent")
            ) {
              publish({ phase: "reading", runId: id })
            }
          })
        },
      })
    } catch (error) {
      if (id !== runId || isAbort(error, controller.signal)) return
      pendingConsent = null
      const kind: ChatCopilotViewError =
        error instanceof ScreenCopilotError ? error.kind : "capture_failed"
      if (await ensureOverlay(null)) publish({ phase: "error", runId: id, error: kind })
      return
    } finally {
      if (run === controller) run = null
    }
    if (id !== runId) return
    read = current
    await ensureOverlay(current.anchor)
    await draft(id, current, "")
  }

  async function handleIntent(intent: ChatCopilotIntent): Promise<void> {
    switch (intent.kind) {
      case "ready":
        if (view) await deps.overlay.send(view)
        return
      case "consent": {
        const pending = pendingConsent
        if (!pending || pending.id !== intent.id) return
        pendingConsent = null
        deps.consent.settle(pending.id)
        const persist = intent.allow && intent.grantDurationMs !== undefined
        await deps.consent.respond({
          id: pending.id,
          allow: intent.allow,
          ...(persist
            ? {
                persist: true,
                prompt: deps.consent.promptOf(pending),
                grantDurationMs: intent.grantDurationMs,
              }
            : {}),
        })
        if (intent.allow) publish({ phase: "capturing", runId })
        return
      }
      case "redraft":
        if (read) await draft(runId, read, intent.instructions)
        return
      case "retry":
        await start()
        return
      case "openScreenRecordingSettings":
        await deps.openScreenRecordingSettings()
        return
      case "close":
        await cancelRun()
        runId += 1
        read = null
        view = null
        release()
        if (overlayOpen) {
          overlayOpen = false
          await deps.overlay.close()
        }
        return
    }
  }

  return {
    start,
    handleIntent,
    dispose: () => {
      unsubscribeConsent()
      void cancelRun()
      release()
    },
  }
}
