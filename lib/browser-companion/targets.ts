/**
 * The delivery targets a Host offers, and the resolution of the one a browser
 * picked.
 *
 * ## The authority argument, restated for a list
 *
 * ADR-0154 rests `browser.submit` on the browser being unable to choose an
 * intent: the Host constructs the action, for a session it just created, with a
 * fixed kind. A catalogue does not weaken that, because the catalogue is the
 * Host's. The extension picks a label out of what it was handed and quotes back
 * an id it did not invent; {@link resolveDeliveryTarget} looks that id up in a
 * list this process just built and answers with a value, never with a parse of
 * the string. An id outside the list is refused exactly as an unoffered
 * `workspaceId` is — as stale client state, not as a new capability.
 *
 * The ids are readable (`chat:new`, `session:<id>`) because a readable id is
 * easier to reason about in a log than a hash. That is presentation. Nothing
 * here splits one to decide what to do; the entry the lookup returns carries
 * everything the caller acts on.
 *
 * ## Why `session:` targets are bounded by the ledger
 *
 * Appending to an existing conversation is the one target that names something
 * the browser did not create in this request, so it is the one that needs a
 * bound. The bound is `browserSubmissions`: the catalogue is built from the
 * rows this device wrote, so the only sessions a browser can ever be offered
 * are the ones it started itself. A second browser paired to the same Host sees
 * its own, and neither sees a conversation started on the desktop.
 */
import type { BrowserDeliveryTargetV1 } from "@/types/browser-companion"

import type { BrowserSubmissionRow } from "@/lib/db/browser-submissions-types"

/** The target every Host offers, and the one a submission means when it names none. */
export const NEW_CHAT_TARGET_ID = "chat:new"

/**
 * The label the Host sends for {@link NEW_CHAT_TARGET_ID}, in English.
 *
 * Not localized here, and the reason is that the Host does not know the
 * browser's language: nothing in the request carries a locale, and the panel
 * runs on Chrome's UI language rather than on this Host's. Every other label in
 * the catalogue is user data — a session title, a workspace name — which is the
 * same in any language; this one is chrome, so the panel renders its own
 * translation for `kind: "chat"` and this stands as the fallback any other
 * client can show verbatim.
 */
export const NEW_CHAT_LABEL = "New task"

/**
 * How many past submissions are offered as append targets.
 *
 * Small on purpose. This is a dropdown in a side panel, not a history: past
 * about half a dozen entries the labels stop being distinguishable (they are
 * page titles, and a person re-capturing a page produces several with the same
 * one), and the way to find an older task is to open Cognia. The recent list
 * directly below shows more.
 */
export const MAX_SESSION_TARGETS = 6

export interface DeliveryTargetDeps {
  /** This device's submissions, newest first — the same reader the list uses. */
  listSubmissions: (deviceId: string, limit: number) => Promise<BrowserSubmissionRow[]>
}

/**
 * What this Host will accept, for this device.
 *
 * `deviceId` rather than "the Host's sessions": every entry beyond the new-task
 * one is derived from what this browser has already sent, so the catalogue is
 * as device-scoped as the reads are.
 */
export async function listDeliveryTargets(
  deps: DeliveryTargetDeps,
  deviceId: string
): Promise<BrowserDeliveryTargetV1[]> {
  const targets: BrowserDeliveryTargetV1[] = [
    { id: NEW_CHAT_TARGET_ID, kind: "chat", label: NEW_CHAT_LABEL, isDefault: true },
  ]
  if (!deviceId) return targets
  const rows = await deps.listSubmissions(deviceId, MAX_SESSION_TARGETS)
  for (const row of rows) {
    // A submission that never started has no conversation to append to. Its
    // own retry is the way to finish it, and offering it here would look like
    // a second, different way to do the same thing.
    if (row.status === "submitting" || row.status === "failed") continue
    targets.push({
      id: sessionTargetId(row.sessionId),
      kind: "session",
      label: row.title,
      isDefault: false,
      // A session already belongs to a workspace; the panel filters on this so
      // it is never offered under a workspace the append would not move it to.
      ...(row.workspaceId ? { workspaceId: row.workspaceId } : {}),
      detail: row.sourceHost,
    })
  }
  return targets
}

/** `session:<id>` — the id form, in one place so the reader and writer agree. */
export function sessionTargetId(sessionId: string): string {
  return `session:${sessionId}`
}

/**
 * The catalogue entry a submission named, or `undefined`.
 *
 * A lookup rather than a parse. The difference matters: parsing `session:<id>`
 * out of the request would let a browser name any session on the Host by
 * writing one down, while a lookup can only ever return something this process
 * put in the list.
 */
export function resolveDeliveryTarget(
  targets: readonly BrowserDeliveryTargetV1[],
  targetId: string | undefined
): BrowserDeliveryTargetV1 | undefined {
  if (!targetId) return targets.find((target) => target.isDefault) ?? targets[0]
  return targets.find((target) => target.id === targetId)
}

/**
 * The session a resolved `session:` target appends to.
 *
 * Reads the suffix of an id that has already survived {@link resolveDeliveryTarget},
 * so by the time this runs the string is one the Host wrote — not one the
 * client sent.
 */
export function sessionIdOfTarget(target: BrowserDeliveryTargetV1): string | undefined {
  if (target.kind !== "session") return undefined
  const sessionId = target.id.slice("session:".length)
  return sessionId.length > 0 ? sessionId : undefined
}
