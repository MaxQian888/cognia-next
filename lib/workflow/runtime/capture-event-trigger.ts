/**
 * `trigger.capture.item` runner (ADR-0060).
 *
 * Subscribes `subscribeCapturePersisted`, which `lib/capture/capture-manager`
 * already exports and describes as "content-free lifecycle milestones for
 * first-party integrations". No new bus and no new emitter: the seam was built
 * for exactly this, and the desktop pet is already on it.
 *
 * PII is the defining constraint here. A captured item IS the user's
 * clipboard, so the bus is content-free by design and this runner must not
 * undo that:
 *
 *  - the payload always carries ids and classification only.
 *  - the source app, and the HOST of the source url (never its path or query,
 *    which is where tracking identifiers live), ride only through
 *    `gateModelText`, which omits when unsafe and fails closed when the gate
 *    itself cannot load.
 *  - the text and the enriched markdown ride only when the node asks for them,
 *    and still through the same gate. The default is off.
 *
 * A workflow that needs the full content reads it downstream by `captureId`,
 * which re-enters the normal read path rather than smuggling clipboard text
 * through a trigger payload into an `io.http` node.
 *
 * Self-feed is not reachable and that is provable rather than asserted: the
 * only production caller of `persistCapture` is the capture bubble, a
 * user-confirmation component. No node, plugin API or MCP tool writes
 * `capturedItems`. There is no cycle to break.
 */

import { loggers } from "@cognia/logging"
import { gateModelText } from "@/lib/runtime/completion-linkage-core"
import {
  createFanOutState,
  disposeFanOut,
  fanOutTrigger,
  type TriggerFanOutState,
} from "./trigger-fan-out"

const log = loggers.scheduler

/** Cap on gated free text, so a whole document cannot ride a trigger payload. */
const MAX_GATED_TEXT_CHARS = 2_000

let state: TriggerFanOutState | null = null

interface CapturePersistedEvent {
  captureId: string
  kind: string
  capturedAt: number
}

/** The host of a url, or undefined. Never the path, never the query. */
function urlHostOf(value: string | undefined): string | undefined {
  if (!value) return undefined
  try {
    return new URL(value).host
  } catch {
    return undefined
  }
}

async function onCapturePersisted(event: CapturePersistedEvent): Promise<void> {
  const s = state
  if (!s || !s.active) return
  try {
    const { findMatchingWorkflows } = await import("./trigger-subscriptions")
    // One read per event, and only after at least one workflow subscribed the
    // kind at all. Reading a captured item is reading the user's clipboard.
    if (
      findMatchingWorkflows("trigger.capture.item", { captureItemKind: event.kind }).length === 0
    ) {
      return
    }

    const { getCapturedItem } = await import("@/lib/db/captured-items")
    const item = await getCapturedItem(event.captureId)
    if (!item) return

    const [sourceApp, urlHost] = await Promise.all([
      gateModelText(item.sourceApp, 120),
      gateModelText(urlHostOf(item.sourceUrl), 253),
    ])

    const matches = findMatchingWorkflows("trigger.capture.item", {
      captureItemKind: item.kind,
      sourceApp,
      urlHost,
      hasEnrichment: item.enrichment !== undefined,
    })
    if (matches.length === 0) return

    // `includeText` is per-node and off by default, so the decision to carry
    // clipboard content is one an author makes deliberately, once, in the open.
    const wantsText = matches.some((match) => match.params.includeText === true)
    const [text, markdown] = wantsText
      ? await Promise.all([
          gateModelText(item.text, MAX_GATED_TEXT_CHARS),
          gateModelText(item.enrichment?.markdown, MAX_GATED_TEXT_CHARS),
        ])
      : [undefined, undefined]

    await fanOutTrigger({
      state: s,
      kind: "trigger.capture.item",
      match: {
        captureItemKind: item.kind,
        sourceApp,
        urlHost,
        hasEnrichment: item.enrichment !== undefined,
      },
      payload: {
        captureId: item.id,
        kind: item.kind,
        capturedAt: item.capturedAt,
        hasEnrichment: item.enrichment !== undefined,
        ...(sourceApp ? { sourceApp } : {}),
        ...(urlHost ? { urlHost } : {}),
        ...(text ? { text } : {}),
        ...(markdown ? { markdown } : {}),
      },
    })
  } catch (error) {
    log.warn("capture-event-trigger: dispatch failed", {
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

export function initCaptureEventTrigger(deps: { now?: () => number } = {}): void {
  if (typeof window === "undefined") return
  disposeCaptureEventTrigger()
  const s = createFanOutState(deps.now ?? Date.now)
  state = s
  void import("@/lib/capture/capture-manager")
    .then(({ subscribeCapturePersisted }) => {
      if (!state || state !== s || !s.active) return
      s.unsubscribe = subscribeCapturePersisted((event) => void onCapturePersisted(event))
    })
    .catch((error) => {
      log.warn("capture-event-trigger: subscribe failed", {
        error: error instanceof Error ? error.message : String(error),
      })
    })
}

export function disposeCaptureEventTrigger(): void {
  disposeFanOut(state)
  state = null
}

/** Test-only: drive one event through the runner without the live bus. */
export async function _injectCapturePersistedForTest(event: CapturePersistedEvent): Promise<void> {
  await onCapturePersisted(event)
}
