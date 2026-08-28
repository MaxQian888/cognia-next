/**
 * What the side panel is showing, as a value rather than a tangle of booleans.
 *
 * There are nine distinguishable situations here and they demand different
 * copy and different controls. Modelled as a union because the alternative —
 * `loading`, `paired`, `error`, `offline` flags — makes states like "paired,
 * offline, and also revoked" representable, and someone eventually renders one.
 *
 * Kept pure and free of React so the transitions can be tested directly. The
 * component reduces over this; it does not decide.
 */
import type {
  BrowserCompanionCapabilityV1,
  BrowserContextSubmissionSummaryV1,
  BrowserSubmissionStatus,
} from "@cognia/companion-client"

import type { PairFailure, PairingRecord } from "./client"

/** The page the user captured, held in memory only. */
export interface CapturedPage {
  tabId: number
  title: string
  /** Already normalized: credentials gone, query/fragment gone unless asked. */
  url: string
  rawUrl: string
  selection: { text: string; truncated: boolean } | null
  readableText: { text: string; truncated: boolean; originalCharacterCount: number } | null
  capturedAt: number
  strippedQuery: boolean
}

export type PanelState =
  /** Before storage has been read. Renders nothing rather than a wrong answer. */
  | { kind: "loading" }
  /** The extension could not read or repair its own local pairing data. */
  | { kind: "storage-error" }
  /** No pairing on this browser. */
  | { kind: "unpaired"; failure?: PairFailure }
  /** A code is being redeemed. */
  | { kind: "pairing" }
  /** Paired, and the Host answered. */
  | {
      kind: "ready"
      pairing: PairingRecord
      capability: BrowserCompanionCapabilityV1
      recent: BrowserContextSubmissionSummaryV1[]
      captured: CapturedPage | null
    }
  /** Paired, but the Host is not answering. Not an error the user caused. */
  | { kind: "host-offline"; pairing: PairingRecord }
  /** The Host says this device is gone. Only re-pairing fixes it. */
  | { kind: "revoked" }
  /** The Host speaks a schema this build does not. */
  | { kind: "incompatible"; hostSchemaVersion: number }

/** The schema version this build of the extension implements. */
export const SUPPORTED_SCHEMA_VERSION = 1

/**
 * Classify a failed Host call.
 *
 * `device_unavailable` and `device_origin_mismatch` both mean "the Host will
 * not talk to this browser again" and are terminal until re-pairing; anything
 * else is treated as the Host being unreachable, which is recoverable and must
 * not throw away a working pairing.
 */
export function panelStateForError(
  error: unknown,
  pairing: PairingRecord
): Extract<PanelState, { kind: "revoked" | "host-offline" }> {
  const code = (error as { code?: unknown })?.code
  if (code === "device_unavailable" || code === "device_origin_mismatch") {
    return { kind: "revoked" }
  }
  return { kind: "host-offline", pairing }
}

/** Whether a capability response is one this build can act on. */
export function isCompatible(capability: { schemaVersion: number }): boolean {
  return capability.schemaVersion === SUPPORTED_SCHEMA_VERSION
}

/**
 * Which capture mode a page's contents imply.
 *
 * A selection wins when there is one: the user has already told the browser
 * what they care about, and sending the whole page instead would send more
 * than they pointed at. Whole-page text is only ever an explicit choice.
 */
export function captureModeFor(
  page: CapturedPage,
  wholePageRequested: boolean
): "metadata" | "selection" | "readable-page" {
  if (wholePageRequested && page.readableText) return "readable-page"
  if (page.selection) return "selection"
  return "metadata"
}

/**
 * How often to ask the Host for status, in milliseconds.
 *
 * Two rates rather than one. While something is running the panel is a
 * progress indicator and three seconds is the difference between "it is
 * working" and "is it stuck?"; once everything is terminal it is a history
 * list, and polling one of those every three seconds is a request per user per
 * three seconds for information that will not change.
 */
export const POLL_ACTIVE_MS = 3_000
export const POLL_IDLE_MS = 15_000

export function pollIntervalFor(recent: { status: string }[]): number {
  const active = recent.some(
    (row) =>
      row.status === "submitting" ||
      row.status === "queued" ||
      row.status === "running" ||
      row.status === "needs_input"
  )
  return active ? POLL_ACTIVE_MS : POLL_IDLE_MS
}

/**
 * Statuses whose row is worth asking `browser_context_get` about.
 *
 * The recent list is deliberately thin and carries no `errorCode`; the single
 * read is the only call that answers *why*. Asking for every row would be a
 * request per row per poll for a field that is empty on all of them.
 */
export const STATUSES_WITH_A_REASON: readonly BrowserSubmissionStatus[] = [
  "failed",
  "host_unavailable",
]

/**
 * The message key for a Host refusal code.
 *
 * A code is a machine token — `runtime_target_unavailable` is not a sentence,
 * and putting it on screen as one is how an enum ends up being read as an error
 * message. Known codes get a localized explanation; anything else is shown as
 * the code it is, clearly framed as something Cognia said rather than as
 * prose the extension wrote.
 */
export function failureReasonMessage(
  code: string,
  message: (key: string, substitutions?: string[]) => string
): string {
  switch (code) {
    case "runtime_target_unavailable":
      return message("reasonNoRuntime")
    case "enqueue_refused":
    case "enqueue_failed":
      return message("reasonRefused")
    default:
      return message("reasonOther", [code])
  }
}
