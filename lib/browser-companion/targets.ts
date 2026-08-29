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
import type { BrowserDeliveryTargetV1, BrowserTargetParamV1 } from "@/types/browser-companion"

import type { ChatTemplateRow } from "@/lib/db/chat-templates"
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

/**
 * How many recent rows are read to find those {@link MAX_SESSION_TARGETS}.
 *
 * A separate number, because most rows in the ledger are not append targets:
 * a `submitting` or `failed` row has no landed conversation, and an issue or an
 * agent task is not a conversation at all. Reading exactly
 * {@link MAX_SESSION_TARGETS} rows and then filtering meant the cap counted
 * rows SCANNED rather than targets OFFERED — six pages filed as issues emptied
 * the dropdown completely, while appendable conversations sat just behind them
 * in a ledger that keeps a hundred per device.
 */
export const SESSION_TARGET_SCAN = 40

export interface DeliveryTargetDeps {
  /** This device's submissions, newest first — the same reader the list uses. */
  listSubmissions: (deviceId: string, limit: number) => Promise<BrowserSubmissionRow[]>
  /** The Host's saved chat templates. */
  listTemplates: () => Promise<ChatTemplateRow[]>
  /**
   * Every issue board, each carrying the workspace it belongs to.
   *
   * All of them rather than one workspace's, because the capability call does
   * not know which workspace the panel has selected — it answers with the whole
   * catalogue and the panel filters on `workspaceId`, the same way it already
   * does for a conversation.
   */
  listIssueProjects: () => Promise<{ id: string; name: string; workspaceId: string }[]>
  /**
   * Agents this Host can actually run a task on.
   *
   * Empty when the host cannot run one at all — an agent task needs the
   * sidecar, and a mobile or plain-browser Host has none. Offering the target
   * there would produce a task that is refused the moment it is dispatched,
   * which is a worse answer than not offering it.
   */
  listTaskAgents: () => Promise<{ id: string; name: string }[]>
}

/** `template:<id>` — the id form, in one place so the reader and writer agree. */
export function templateTargetId(templateId: string): string {
  return `template:${templateId}`
}

/** `issue:<issueProjectId>` — file the page on that board. */
export function issueTargetId(issueProjectId: string): string {
  return `issue:${issueProjectId}`
}

/** `agent-task:<characterId>` — hand the page to that agent. */
export function agentTaskTargetId(characterId: string): string {
  return `agent-task:${characterId}`
}

/**
 * A template's parameters, or `null` when a browser cannot fill them.
 *
 * `resource` parameters are the boundary. One is filled through the `@` menu
 * against the Host's own workspace, and a side panel has neither that picker
 * nor any business enumerating the Host's files to build one. A template that
 * declares one is not offered at all: a field that cannot be completed is a
 * worse answer than an absent target.
 */
export function browserFillableParams(template: ChatTemplateRow): BrowserTargetParamV1[] | null {
  const params: BrowserTargetParamV1[] = []
  for (const param of template.params) {
    if (param.kind === "resource") return null
    const remembered = template.lastParams?.[param.id]
    params.push({
      id: param.id,
      label: param.label,
      required: param.required,
      kind: param.kind,
      ...(param.description ? { description: param.description } : {}),
      ...(param.options ? { options: param.options } : {}),
      ...(param.multiline ? { multiline: param.multiline } : {}),
      // The last value wins over the declared default, matching what the
      // composer offers: nine uses out of ten repeat most of the values.
      ...(remembered?.kind === "text"
        ? { defaultValue: remembered.value }
        : param.defaultValue
          ? { defaultValue: param.defaultValue }
          : {}),
    })
  }
  return params
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
  const rows = await deps.listSubmissions(deviceId, SESSION_TARGET_SCAN)
  let offeredSessions = 0
  for (const row of rows) {
    if (offeredSessions >= MAX_SESSION_TARGETS) break
    // A submission that never started has no conversation to append to. Its
    // own retry is the way to finish it, and offering it here would look like
    // a second, different way to do the same thing.
    if (row.status === "submitting" || row.status === "failed") continue
    // Only a conversation can be appended to. A filed issue and an agent task
    // are work on their own planes, and "add this page to that" would mean
    // something different for each.
    if (!row.sessionId || (row.workKind && row.workKind !== "session")) continue
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
    offeredSessions += 1
  }
  for (const template of await deps.listTemplates()) {
    const params = browserFillableParams(template)
    if (!params) continue
    targets.push({
      id: templateTargetId(template.id),
      kind: "template",
      label: template.name,
      isDefault: false,
      // No `workspaceId`: a template describes how to start a task, not where.
      // It runs in whichever workspace the submission names, exactly as a new
      // task does.
      ...(template.description ? { detail: template.description } : {}),
      ...(params.length > 0 ? { params } : {}),
    })
  }
  for (const board of await deps.listIssueProjects()) {
    targets.push({
      id: issueTargetId(board.id),
      kind: "issue",
      label: board.name,
      isDefault: false,
      // A board belongs to a workspace, so the target does too — filing does
      // not move an issue between them any more than an append moves a
      // conversation.
      workspaceId: board.workspaceId,
    })
  }
  for (const agent of await deps.listTaskAgents()) {
    targets.push({
      id: agentTaskTargetId(agent.id),
      kind: "agent-task",
      label: agent.name,
      isDefault: false,
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

/** The template a resolved `template:` target runs, by the same rule. */
export function templateIdOfTarget(target: BrowserDeliveryTargetV1): string | undefined {
  if (target.kind !== "template") return undefined
  const templateId = target.id.slice("template:".length)
  return templateId.length > 0 ? templateId : undefined
}

/** The board a resolved `issue:` target files on. */
export function issueProjectIdOfTarget(target: BrowserDeliveryTargetV1): string | undefined {
  if (target.kind !== "issue") return undefined
  const boardId = target.id.slice("issue:".length)
  return boardId.length > 0 ? boardId : undefined
}

/** The agent a resolved `agent-task:` target hands the page to. */
export function agentIdOfTarget(target: BrowserDeliveryTargetV1): string | undefined {
  if (target.kind !== "agent-task") return undefined
  const agentId = target.id.slice("agent-task:".length)
  return agentId.length > 0 ? agentId : undefined
}
