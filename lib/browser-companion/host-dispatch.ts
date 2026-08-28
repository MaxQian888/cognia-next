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
import type { BrowserCompanionCapabilityV1 } from "@/types/browser-companion"
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
import { browserStatusForRun } from "./run-status"
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

/** The four commands this module answers. */
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
    listDeliveryTargets: (callerDeviceId) =>
      listDeliveryTargets({ listSubmissions: listBrowserSubmissions }, callerDeviceId),
    // Built from the same readers the capability call uses, so the digest and
    // the answer it describes cannot disagree — a revision derived from
    // anything else would be a second definition of "what the capability is".
    capabilityRevision: async (callerDeviceId) =>
      capabilityRevisionOf({
        workspaces: await listHostWorkspaces(),
        deliveryTargets: await listDeliveryTargets(
          { listSubmissions: listBrowserSubmissions },
          callerDeviceId
        ),
        ...(await hostAppearance()),
      }),
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
 * The last thing the assistant said in a session.
 *
 * Text parts only. A tool call, a file part or a reasoning block is not an
 * answer, and concatenating them would hand the panel a wall of machinery
 * instead of the reply — the deep link is how somebody reads the rest.
 *
 * `null` rather than an empty string when there is nothing yet, so the caller
 * can tell "the task has not answered" from "the task answered with nothing".
 */
async function latestAssistantAnswer(
  sessionId: string
): Promise<{ text: string; at: number } | null> {
  const { listMessages } = await import("@/lib/db/messages")
  const messages = await listMessages(sessionId)
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
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
    const at = message.metadata?.createdAt
    return { text, at: typeof at === "number" ? at : Date.now() }
  }
  return null
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
 * another device holds the attach lease. That refusal is returned as `false`
 * rather than thrown: it means the run is healthy and the desktop is driving
 * it, which is a different thing to tell somebody than "this failed".
 */
async function abortOnHostAuthority(
  payload: Record<string, unknown>,
  resolveHostState: HostStateResolver,
  sessionId: string
): Promise<boolean> {
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
  return receipt?.outcome === "applied" || receipt?.outcome === "duplicate"
}
