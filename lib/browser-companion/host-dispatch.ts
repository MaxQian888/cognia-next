/**
 * Production wiring for the Browser Companion commands.
 *
 * `service.ts` holds the decisions and takes every collaborator as a
 * parameter; this module is the one place those parameters are filled with the
 * real thing. Splitting them is what lets the submit path be tested end to end
 * without a Dexie database, a runtime target or a live agent — and this file
 * stays small enough to read as a wiring diagram, which is the only way an
 * injected-deps default is ever actually verified.
 */
import { startNewSession } from "@/lib/chat/start-session"
import type { ChatTemplateBinding, ChatTemplateParamValue } from "@/lib/chat/template/binding"
import { listParamTokens } from "@/lib/chat/template/param-segments"
import { renderParamTokens } from "@/lib/chat/template/render-params"
import { getChatTemplate, listChatTemplates, recordChatTemplateUse } from "@/lib/db/chat-templates"
import type {
  BrowserCompanionCapabilityV1,
  BrowserSubmissionStatus,
} from "@/types/browser-companion"
import {
  getBrowserSubmission,
  listBrowserSubmissions,
  putBrowserSubmission,
} from "@/lib/db/browser-submissions"
import { listExecutionRuns } from "@/lib/db/execution-runs"
import { getActiveRuntimeTargetContext } from "@/lib/runtime/runtime-target-context"
import { getSettings } from "@/lib/db/settings"
import type { HostStateService } from "@/lib/sync/host-state-service"
import type { HostStateAction } from "@cognia/agent-config-types/host-state"
import { sessionStateChannel } from "@cognia/agent-config-types/host-state"

import { buildBrowserCompanionAppearance, capabilityRevisionOf } from "./appearance"
import { listDeliveryTargets } from "./targets"
import { browserStatusForAgentTask, browserStatusForIssue, browserStatusForRun } from "./run-status"
import {
  BrowserCompanionError,
  browserCompanionCapability,
  cancelBrowserContext,
  getBrowserContextResult,
  getBrowserContextSubmission,
  listBrowserContextSubmissions,
  submitBrowserContext,
  type BrowserCompanionDeps,
} from "./service"

/** The six commands this module answers. */
export const BROWSER_COMPANION_COMMANDS: readonly string[] = [
  "browser_companion_capability",
  "browser_context_submit",
  "browser_context_list",
  "browser_context_get",
  "browser_context_result",
  "browser_context_cancel",
]

export function isBrowserCompanionCommand(command: string): boolean {
  return BROWSER_COMPANION_COMMANDS.includes(command)
}

/** Resolve the HostState authority for the current runtime target. */
export type HostStateResolver = (payload: Record<string, unknown>) => Promise<HostStateService>

export async function dispatchBrowserCompanionCommand(
  command: string,
  payload: Record<string, unknown>,
  resolveHostState: HostStateResolver
): Promise<unknown> {
  const deviceId = typeof payload.callerDeviceId === "string" ? payload.callerDeviceId : ""
  const deps = createBrowserCompanionDeps(payload, resolveHostState)
  switch (command) {
    case "browser_companion_capability":
      return browserCompanionCapability(deps, deviceId, payload)
    case "browser_context_submit":
      return submitBrowserContext(deps, deviceId, payload)
    case "browser_context_list":
      return listBrowserContextSubmissions(deps, deviceId, {
        limit: typeof payload.limit === "number" ? payload.limit : undefined,
      })
    case "browser_context_get":
      return getBrowserContextSubmission(deps, deviceId, payload)
    case "browser_context_result":
      return getBrowserContextResult(deps, deviceId, payload)
    case "browser_context_cancel":
      return cancelBrowserContext(deps, deviceId, payload)
    default:
      throw new BrowserCompanionError("unknown_command", `unknown command: ${command}`)
  }
}

export function createBrowserCompanionDeps(
  payload: Record<string, unknown>,
  resolveHostState: HostStateResolver
): BrowserCompanionDeps {
  return {
    now: () => Date.now(),
    listWorkspaces: listHostWorkspaces,
    appearance: hostAppearance,
    createSession: async ({ title, projectId }) => {
      const session = await startNewSession({ title, projectId })
      return { id: session.id }
    },
    enqueueMessage: (input) => enqueueOnHostAuthority(payload, resolveHostState, input),
    listDeliveryTargets: (callerDeviceId) => listDeliveryTargets(targetDeps(), callerDeviceId),
    renderTemplate: renderHostTemplate,
    // Built from the same readers the capability call uses, so the digest and
    // the answer it describes cannot disagree — a revision derived from
    // anything else would be a second definition of "what the capability is".
    capabilityRevision: cachedCapabilityRevision,
    createIssue: fileHostIssue,
    createAgentTask: startHostAgentTask,
    workStatus: hostWorkStatus,
    latestAnswer: latestAssistantAnswer,
    abortTurn: (sessionId) => abortOnHostAuthority(payload, resolveHostState, sessionId),
    recordSubmission: putBrowserSubmission,
    readSubmission: getBrowserSubmission,
    listSubmissions: listBrowserSubmissions,
    // `null` means "this session has no run", which is not the same as "the run
    // is queued". A submission whose enqueue was refused has a session and no
    // run, and answering `queued` there overwrote the recorded failure with a
    // reassuring lie on the very next poll.
    sessionStatus: async (sessionId) => {
      const runs = await listExecutionRuns({ sessionId, limit: 1 })
      const latest = runs[0]
      return latest ? browserStatusForRun(latest.status) : null
    },
  }
}

/**
 * The workspaces a submission may be aimed at.
 *
 * Read from the project store, which is what the desktop's own workspace
 * switcher shows. A browser that offered a different set would be offering
 * places the user does not recognise.
 */
async function listHostWorkspaces(): Promise<{ id: string; label: string; isDefault: boolean }[]> {
  const { useProjectStore } = await import("@/stores/project/project-store")
  const store = useProjectStore.getState()
  if (store.projects.length === 0) await store.load().catch(() => undefined)
  const { projects, activeProjectId } = useProjectStore.getState()
  return projects.map((project) => ({
    id: project.id,
    label: project.name,
    isDefault: project.id === activeProjectId,
  }))
}

/**
 * The Host's appearance, read from the database rather than from a store.
 *
 * `preferredMode` wins over the Host's own setting when the panel sent one.
 * That is the local override and the system-theme answer both: a Host set to
 * "follow the system" cannot see the browser's system theme — nothing in the
 * request carries it — so it says `followsSystem` and lets the panel come back
 * with the mode it actually resolved.
 *
 * This used to read `useSettingsStore`, which is hydrated by exactly one thing
 * in the repo: `components/providers/settings-hydrator.tsx`. A headless brain
 * has no React tree, so on that host — the one a browser reaches when Cognia is
 * served as a web app or self-hosted — `settings` was null forever and the
 * panel was painted with the stock dark preset. The failure was silent, because
 * "null for the first moments after boot" is also what a host that never
 * hydrates looks like.
 *
 * `getSettings()` merges the defaults under the persisted row, so it answers
 * with a real `AppSettings` on every host, hydrated or not. Its sibling
 * `listHostWorkspaces` already self-hydrates for the same reason.
 */
async function hostAppearance(preferredMode?: "light" | "dark"): Promise<{
  appearance: BrowserCompanionCapabilityV1["appearance"]
  followsSystem: boolean
}> {
  const settings = await getSettings()
  const followsSystem = settings.theme !== "light" && settings.theme !== "dark"
  const appearance = buildBrowserCompanionAppearance({
    colorTheme: settings.colorTheme ?? "default",
    // Dark is the fallback only when nobody has said anything better: the
    // panel's override first, then the Host's explicit choice. A Host set to
    // "follow the system" used to land here and resolve to dark for everyone,
    // including people whose system is light.
    resolvedTheme: (preferredMode ?? settings.theme) === "light" ? "light" : "dark",
    activeCustomThemeId: settings.activeCustomThemeId ?? null,
    customThemes: settings.customThemes ?? [],
    accentColor: settings.accentColor,
    a11y: settings.a11y,
    stylePackId: settings.stylePack?.packId,
    density: settings.density?.global,
  })
  return { appearance, followsSystem }
}

/**
 * Enqueue the message on the **Host's** authority.
 *
 * `message.enqueue` requires `workspace.write`, and a browser device does not
 * hold it. This is not a bypass of that rule: the action is constructed here,
 * for a session this process just created, with a fixed intent kind and a
 * single-element batch. The browser supplied an instruction and a captured
 * page — it named no session, chose no intent, and cannot reach this function
 * with anything else. `browser.submit` is the capability for that one closed
 * effect, which is the same shape `agent.worker` has.
 *
 * A delivery target does not change this. The browser picks an entry out of a
 * catalogue the Host built and quotes its id back; the Host looks that id up
 * (never parses it) and builds the action from the entry it found. The intent
 * kind is still `message.enqueue`, still constructed here, still a batch of
 * one. What varies is which session it names, and every session it can name is
 * one this device started — see `targets.ts`.
 *
 * If this ever needs to submit a second intent *kind*, it must stop
 * constructing the caller and start deriving it, because at that point the
 * browser would be choosing.
 */
async function enqueueOnHostAuthority(
  payload: Record<string, unknown>,
  resolveHostState: HostStateResolver,
  input: { sessionId: string; messageId: string; text: string }
): Promise<void> {
  const active = getActiveRuntimeTargetContext()
  if (!active) {
    throw new BrowserCompanionError(
      "runtime_target_unavailable",
      "this Host has no active runtime target"
    )
  }
  const service = await resolveHostState({ ...payload, runtimeTargetId: active.targetId })
  const status = await service.status()
  const action: HostStateAction = {
    channel: sessionStateChannel(active.targetId, input.sessionId),
    accountId: active.accountId,
    runtimeTargetId: active.targetId,
    hostId: status.hostId,
    hostGeneration: status.hostGeneration,
    sessionId: input.sessionId,
    clientId: "browser-companion",
    clientSeq: Date.now(),
    // Stable, and derived from the submission: a redrive after a crash must
    // resolve to the same action rather than appending a second message.
    actionId: `browser:${input.messageId}`,
    createdAt: Date.now(),
    action: {
      kind: "message.enqueue",
      messageId: input.messageId,
      text: input.text,
      attachments: [],
    },
  }
  const response = await service.submit(
    { accountId: active.accountId, runtimeTargetId: active.targetId, actions: [action] },
    // See this function's docstring. Constructed, not forwarded.
    { deviceId: "host:browser-companion", grants: ["workspace.write"] }
  )
  const receipt = response.results[0]
  // `duplicate` is a success: it is what a redrive of the same `actionId`
  // returns, and the message it names is already in the transcript. Only
  // `rejected` and `conflicted` mean nothing was enqueued.
  if (!receipt || (receipt.outcome !== "applied" && receipt.outcome !== "duplicate")) {
    throw new BrowserCompanionError(
      "enqueue_refused",
      `the Host refused the message: ${receipt?.outcome ?? "no receipt"}`
    )
  }
}

/**
 * How many rows to deserialize at once while looking for the assistant's last
 * words.
 *
 * Paging keeps memory bounded without changing the meaning of "latest": a long
 * tool/reasoning tail may contain more than one page of rows before the text
 * answer it belongs to.
 */
const LATEST_ANSWER_PAGE_SIZE = 50

/**
 * The last thing the assistant said in a session.
 *
 * Text parts only. A tool call, a file part or a reasoning block is not an
 * answer, and concatenating them would hand the panel a wall of machinery
 * instead of the reply — the deep link is how somebody reads the rest.
 *
 * Reads the tail directly off the `[sessionId+createdAt]` index rather than
 * through `listMessages`, which has no bound and hoists metadata this does not
 * look at. `createdAt` comes off the column for the same reason.
 *
 * `null` rather than an empty string when there is nothing yet, so the caller
 * can tell "the task has not answered" from "the task answered with nothing".
 */
async function latestAssistantAnswer(
  sessionId: string
): Promise<{ text: string; at: number } | null> {
  const { getDb } = await import("@/lib/db/schema")
  // Newest first, so the first hit is the answer and the first page handles the
  // common case. Further pages preserve correctness for machinery-heavy turns.
  for (let offset = 0; ; offset += LATEST_ANSWER_PAGE_SIZE) {
    const rows = await getDb()
      .messages.where("[sessionId+createdAt]")
      .between([sessionId, 0], [sessionId, Number.MAX_SAFE_INTEGER])
      .reverse()
      .offset(offset)
      .limit(LATEST_ANSWER_PAGE_SIZE)
      .toArray()
    for (const message of rows) {
      if (message.role !== "assistant") continue
      const text = (message.parts ?? [])
        .filter(
          (part): part is { type: "text"; text: string } =>
            typeof part === "object" &&
            part !== null &&
            (part as { type?: unknown }).type === "text" &&
            typeof (part as { text?: unknown }).text === "string"
        )
        .map((part) => part.text)
        .join("")
        .trim()
      if (!text) continue
      return { text, at: typeof message.createdAt === "number" ? message.createdAt : Date.now() }
    }
    if (rows.length < LATEST_ANSWER_PAGE_SIZE) return null
  }
}

/**
 * Abort the turn running on a session, on the **Host's** authority.
 *
 * Same argument as the enqueue above, and the same constructed caller: the
 * action is built here, for a session the caller has already been proved to own
 * (`getBrowserContextSubmission` answers a submission belonging to another
 * device exactly as it answers a missing one), with a fixed intent kind and a
 * batch of one.
 *
 * `turn.abort` is a live-control intent, so `isSecondClaimant` refuses it while
 * another device holds the attach lease. That refusal is returned rather than
 * thrown: it means the run is healthy and the desktop is driving it, which is a
 * different thing to tell somebody than "this failed".
 *
 * The receipt's `rejection.code` is carried out with it. Collapsing every
 * non-applied outcome into one boolean made `conflicted` (a stale
 * `hostGeneration`) and every other rejection read as the second-claimant
 * refusal, so the panel told people to go stop the task on a device that was
 * not driving it.
 */
async function abortOnHostAuthority(
  payload: Record<string, unknown>,
  resolveHostState: HostStateResolver,
  sessionId: string
): Promise<{ stopped: boolean; reasonCode?: string }> {
  const active = getActiveRuntimeTargetContext()
  if (!active) {
    throw new BrowserCompanionError(
      "runtime_target_unavailable",
      "this Host has no active runtime target"
    )
  }
  const service = await resolveHostState({ ...payload, runtimeTargetId: active.targetId })
  const status = await service.status()
  const action: HostStateAction = {
    channel: sessionStateChannel(active.targetId, sessionId),
    accountId: active.accountId,
    runtimeTargetId: active.targetId,
    hostId: status.hostId,
    hostGeneration: status.hostGeneration,
    sessionId,
    clientId: "browser-companion",
    clientSeq: Date.now(),
    // Not derived from a submission id: a person may stop the same task twice,
    // and the second press must reach the runtime rather than replay the first
    // receipt.
    actionId: `browser-abort:${sessionId}:${Date.now()}`,
    createdAt: Date.now(),
    action: { kind: "turn.abort" },
  }
  const response = await service.submit(
    { accountId: active.accountId, runtimeTargetId: active.targetId, actions: [action] },
    { deviceId: "host:browser-companion", grants: ["workspace.write"] }
  )
  const receipt = response.results[0]
  if (receipt?.outcome === "applied" || receipt?.outcome === "duplicate") {
    return { stopped: true }
  }
  return {
    stopped: false,
    // The rejection's own code when there is one; otherwise the outcome, so
    // `conflicted` and "no receipt" still say something specific.
    ...(receipt?.rejection?.code
      ? { reasonCode: receipt.rejection.code }
      : receipt
        ? { reasonCode: receipt.outcome }
        : {}),
  }
}

/**
 * How long a computed revision stands before it is recomputed.
 *
 * The digest rides on `browser_context_list`, which the panel polls every three
 * seconds while anything is running — and computing it reads the settings row,
 * builds a full palette, loads the workspaces, and enumerates submissions,
 * templates, issue boards and characters, only to throw all of it away and keep
 * eight hex characters. None of those change on their own; they change when the
 * user does something in the app.
 *
 * Two seconds is under the poll interval, so a panel that asks twice in quick
 * succession (a list plus the refresh a submission triggers) pays once, while a
 * theme or workspace change is still noticed on the following tick.
 */
const CAPABILITY_REVISION_TTL_MS = 2_000

/**
 * The last computed revision per device, with the wall clock it was computed
 * at.
 *
 * Per device because the catalogue is device-scoped: the session targets in it
 * are the ones that browser started, so two paired browsers legitimately have
 * different digests.
 */
const capabilityRevisionCache = new Map<string, { at: number; revision: string }>()

/**
 * Drop every entry past its TTL.
 *
 * The key is caller-supplied, so without this the map is a device id the Host
 * never forgets: a browser that pairs once, submits once and is never seen
 * again keeps a row for the life of the process, and nothing removes the rows
 * of unpaired or revoked devices either. An expired entry is worthless by
 * definition — it would be recomputed on the next read — so the sweep costs
 * nothing but the walk, on a map that only ever holds live pollers.
 */
function evictStaleCapabilityRevisions(now: number): void {
  for (const [deviceId, entry] of capabilityRevisionCache) {
    if (now - entry.at >= CAPABILITY_REVISION_TTL_MS) capabilityRevisionCache.delete(deviceId)
  }
}

async function cachedCapabilityRevision(callerDeviceId: string): Promise<string> {
  const now = Date.now()
  const cached = capabilityRevisionCache.get(callerDeviceId)
  if (cached && now - cached.at < CAPABILITY_REVISION_TTL_MS) return cached.revision
  evictStaleCapabilityRevisions(now)
  const revision = capabilityRevisionOf({
    workspaces: await listHostWorkspaces(),
    deliveryTargets: await listDeliveryTargets(targetDeps(), callerDeviceId),
    ...(await hostAppearance()),
  })
  capabilityRevisionCache.set(callerDeviceId, { at: now, revision })
  return revision
}

/** Test seam — the cache is process-global, so a suite has to be able to drop it. */
export function __resetCapabilityRevisionCacheForTests(): void {
  capabilityRevisionCache.clear()
}

/**
 * The readers the target catalogue is built from.
 *
 * Named once so the capability call and the digest that describes it cannot end
 * up reading different things — a revision derived from a different catalogue
 * than the one that was sent is a revision that lies.
 */
function targetDeps() {
  return {
    listSubmissions: listBrowserSubmissions,
    listTemplates: listChatTemplates,
    listIssueProjects: hostIssueBoards,
    listTaskAgents: hostTaskAgents,
  }
}

/**
 * Every issue board this Host has, tagged with the workspace it belongs to.
 *
 * Open boards only: a completed, cancelled or paused board is not a place to
 * file new work, and offering one would put an issue somewhere nobody is
 * looking.
 *
 * `backlog` IS a place to file new work, and leaving it out made the whole
 * file-as-issue target invisible for the common case: `createIssueProject`
 * stamps `backlog` on every new board, so a user who had just made a project
 * opened the side panel and found no issue target at all — indistinguishable
 * from a Host that cannot file issues. A board nobody has started yet is
 * exactly where an unsorted capture belongs.
 */
const FILEABLE_BOARD_STATUSES = ["backlog", "planned", "in_progress"] as const

async function hostIssueBoards(): Promise<{ id: string; name: string; workspaceId: string }[]> {
  const { listIssueProjects } = await import("@/lib/db/issue-projects")
  const boards = await listIssueProjects({ statuses: FILEABLE_BOARD_STATUSES })
  return boards.map((board) => ({
    id: board.id,
    name: board.name,
    workspaceId: board.projectId,
  }))
}

/**
 * The agents a task may be handed to, or none.
 *
 * An agent task runs through the scheduler's `agent` executor, which
 * `host-support.ts` gates on the `sidecar` capability. A Host without one — a
 * phone, a plain browser — would accept the task and refuse it at dispatch, so
 * the target is simply not offered there. That check is the scheduler's own, so
 * this cannot drift from what the executor will actually accept.
 */
async function hostTaskAgents(): Promise<{ id: string; name: string }[]> {
  const { getTaskTypeHostSupport } = await import("@/lib/scheduler/host-support")
  if (!getTaskTypeHostSupport("agent").supported) return []
  const { listCharacters } = await import("@/lib/db/characters")
  const characters = await listCharacters()
  return characters.map((character) => ({ id: character.id, name: character.name }))
}

/**
 * Render a saved template's body with the values a submission supplied.
 *
 * On the Host because the body lives here and stays here: it is the user's own
 * saved prompt, and the panel only ever needs to know which fields to show. The
 * substitution is `renderParamTokens`, the same pass the composer uses, over
 * the tokens `listParamTokens` finds — so a template that behaves one way when
 * inserted in the app behaves the same way when a browser runs it.
 *
 * Only declared parameters are read. A value naming something the template does
 * not declare is dropped rather than substituted, which is what keeps a client
 * from introducing a token of its own.
 *
 * `recordChatTemplateUse` runs on the way out so a template used from a browser
 * counts, and its values are remembered for the next use exactly as they would
 * be from the composer.
 */
async function renderHostTemplate(
  templateId: string,
  values: Record<string, string>
): Promise<{ text: string; missing: string[] } | null> {
  const template = await getChatTemplate(templateId)
  if (!template) return null

  const params: Record<string, ChatTemplateParamValue> = {}
  const missing: string[] = []
  for (const declared of template.params) {
    // `resource` is never offered to a browser, so a value for one can only
    // come from a client that made it up.
    if (declared.kind === "resource") continue
    const supplied = values[declared.id]?.trim()
    if (supplied) {
      params[declared.id] = { kind: "text", value: supplied }
      continue
    }
    const fallback =
      template.lastParams?.[declared.id] ??
      (declared.defaultValue ? { kind: "text" as const, value: declared.defaultValue } : undefined)
    if (fallback) {
      params[declared.id] = fallback
      continue
    }
    if (declared.required) missing.push(declared.label || declared.id)
  }
  if (missing.length > 0) return { text: "", missing }

  const binding: ChatTemplateBinding = {
    templateId: template.id,
    version: String(template.revision),
    params,
    insertedAt: Date.now(),
  }
  const rendered = renderParamTokens(template.body, listParamTokens(template.body), binding)
  await recordChatTemplateUse(template.id, params).catch(() => undefined)
  return { text: rendered.text, missing: [] }
}

/**
 * File a captured page on an issue board.
 *
 * `origin` records that a browser filed it — the same field an IM-created issue
 * uses, so the board can say where a card came from without the tracker growing
 * a browser-shaped special case. `createdBy` is the human who was looking at
 * the page: a browser is not an actor on this plane, it is a place the person
 * was standing.
 */
async function fileHostIssue(input: {
  issueProjectId: string
  workspaceId: string
  title: string
  description: string
  sourceHost: string
  url: string
}): Promise<{ id: string }> {
  const { createIssue } = await import("@/lib/db/issues")
  const issue = await createIssue({
    projectId: input.workspaceId,
    issueProjectId: input.issueProjectId,
    title: input.title,
    // The address goes in the body rather than only in `origin`, because the
    // board renders a description and not a provenance record.
    description: `${input.description}\n\n${input.url}`.trim(),
    createdBy: { kind: "human" },
    origin: { kind: "browser", sourceHost: input.sourceHost },
  })
  return { id: issue.id }
}

/**
 * Create an agent task for the captured page and start it.
 *
 * Started rather than left pending because "send this page to an agent" is a
 * request to do something: a task queued where nobody is looking would be the
 * issue target wearing another name. `runAgentTaskNow` is the same path the
 * task board's own Run button takes, so approvals and the scheduler's host
 * gating apply unchanged.
 */
async function startHostAgentTask(input: {
  agentId: string
  workspaceId: string
  title: string
  description: string
}): Promise<{ id: string }> {
  const { createAgentTask } = await import("@/lib/db/agent-tasks")
  const { runAgentTaskNow } = await import("@/lib/agent-tasks/runtime")
  const task = await createAgentTask({
    agentId: input.agentId,
    projectId: input.workspaceId,
    title: input.title,
    description: input.description,
  })
  // Not awaited for its result: the run is a turn that may take minutes, and
  // the RPC answers as soon as the work is accepted. A failure to start is
  // read back by `workStatus` on the next poll rather than turned into a
  // refusal of a task that has already been created.
  void runAgentTaskNow(task.id).catch(() => undefined)
  return { id: task.id }
}

/**
 * The status of work that is not a conversation, projected onto the panel's
 * vocabulary.
 *
 * `null` when the plane has nothing to say — the issue or task was deleted, or
 * the reader is unavailable — which leaves the recorded status standing rather
 * than rewriting history as a failure.
 */
async function hostWorkStatus(
  kind: "issue" | "agent-task",
  workId: string
): Promise<BrowserSubmissionStatus | null> {
  if (kind === "issue") {
    const { getIssue } = await import("@/lib/db/issues")
    const issue = await getIssue(workId)
    return issue ? browserStatusForIssue(issue.status) : null
  }
  const { getAgentTask } = await import("@/lib/db/agent-tasks")
  const task = await getAgentTask(workId)
  return task ? browserStatusForAgentTask(task.status) : null
}
