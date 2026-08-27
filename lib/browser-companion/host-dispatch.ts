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
import {
  getBrowserSubmission,
  listBrowserSubmissions,
  putBrowserSubmission,
} from "@/lib/db/browser-submissions"
import { listExecutionRuns } from "@/lib/db/execution-runs"
import { getActiveRuntimeTargetContext } from "@/lib/runtime/runtime-target-context"
import type { HostStateService } from "@/lib/sync/host-state-service"
import { useSettingsStore } from "@/stores/settings"
import type { HostStateAction } from "@cognia/agent-config-types/host-state"
import { sessionStateChannel } from "@cognia/agent-config-types/host-state"

import { buildBrowserCompanionAppearance } from "./appearance"
import { BROWSER_STATUS_WITHOUT_RUN, browserStatusForRun } from "./run-status"
import {
  BrowserCompanionError,
  browserCompanionCapability,
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
      return browserCompanionCapability(deps)
    case "browser_context_submit":
      return submitBrowserContext(deps, deviceId, payload)
    case "browser_context_list":
      return listBrowserContextSubmissions(deps, deviceId, {
        limit: typeof payload.limit === "number" ? payload.limit : undefined,
      })
    case "browser_context_get":
      return getBrowserContextSubmission(deps, deviceId, payload)
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
    recordSubmission: putBrowserSubmission,
    readSubmission: getBrowserSubmission,
    listSubmissions: listBrowserSubmissions,
    sessionStatus: async (sessionId) => {
      const runs = await listExecutionRuns({ sessionId, limit: 1 })
      const latest = runs[0]
      return latest ? browserStatusForRun(latest.status) : BROWSER_STATUS_WITHOUT_RUN
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
 * The Host's appearance, or the stock one before settings have hydrated.
 *
 * `settings` is legitimately null for the first moments after boot, and a
 * capability call can land there. Falling back to the default preset is right:
 * it is the same palette the stylesheet is painting at that instant, so the
 * panel matches what the user is looking at rather than a guess.
 */
function hostAppearance() {
  const settings = useSettingsStore.getState().settings
  return buildBrowserCompanionAppearance({
    colorTheme: settings?.colorTheme ?? "default",
    resolvedTheme: settings?.theme === "light" ? "light" : "dark",
    activeCustomThemeId: settings?.activeCustomThemeId ?? null,
    customThemes: settings?.customThemes ?? [],
    accentColor: settings?.accentColor,
    a11y: settings?.a11y,
    stylePackId: settings?.stylePack?.packId,
    density: settings?.density?.global,
  })
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
 * If this ever needs to submit a second intent kind, it must stop constructing
 * the caller and start deriving it, because at that point the browser would be
 * choosing.
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
