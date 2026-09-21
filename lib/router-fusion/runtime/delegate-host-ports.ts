/**
 * The four ports a delegate run needs on this device, built in one call
 * (ADR-0188 B4, WP-D3).
 *
 * `runDelegateWorkflow` takes `workspace`, `acceptance`, `tools`, `journal`
 * and `approvals`. The first four are this device's — a workspace it can read
 * and stage into, a sandbox it can run the approved acceptance command in, the
 * `delegate-work-1` tool runtime, and the durable step journal. The fifth is
 * not: an approval is a person's answer, and WP-D4 owns where it is parked and
 * how it is resumed.
 *
 * # How WP-D4 calls this
 *
 * ```ts
 * const { createDelegateHostPorts } = await import("@/lib/router-fusion/runtime/delegate-host-ports")
 * const hostPorts = createDelegateHostPorts({
 *   runId: run.runId,
 *   projectId,                       // the run's project; the profile is per project
 *   workspaceRoot: run.workspaceRoot!, // the user's checkout; never written except by an approved apply
 *   acceptanceProfileId: action.extension.acceptance_profile_id ?? "default",
 *   store,                           // the run's FusionLedgerStore (receipts, artifacts)
 *   now,
 *   newId,
 * })
 * const outcome = await runDelegateWorkflow(
 *   { ...durableCallPorts, artifacts, newId, ...hostPorts, approvals },
 *   delegateInput
 * )
 * ```
 *
 * `hostPorts.workspace.dispose()` gives the run's two worktrees back; call it
 * once, when the run reaches a terminal state (including a failure and a
 * cancel), and never while it is parked `waiting_for_approval` — a resumed run
 * re-snapshots only if the workspace is still at its base revision.
 *
 * `hostPorts.journal` is in memory until WP-D4 adds `fusionDelegateSteps`
 * (the table shape is specified in `delegate-step-journal.ts`); pass
 * `journalStore` to make it durable. Everything else is production-wired.
 *
 * A run with no `workspaceRoot` must not reach here: delegate needs a
 * workspace, and the router excludes it without one.
 */

import type {
  AcceptancePort,
  DelegateStepJournal,
  DelegateToolRuntime,
  ToolRuntime,
} from "@cognia/router-fusion"

import type { FusionLedgerStore } from "../db/ledger-store"
import { createHostToolRuntime } from "../tools/tool-runtime"
import {
  createDelegateWorkspacePort,
  type DelegateWorkspaceHost,
  type DelegateWorkspacePort,
} from "../tools/workspace-patch"
import {
  createDelegateAcceptancePort,
  defaultAcceptanceSandboxHost,
  resolveProjectContainerImage,
  type AcceptanceProfileResolver,
  type AcceptanceResourceLimits,
  type AcceptanceSandboxHost,
} from "../verify/code-acceptance-host"
import { resolveAcceptanceProfile } from "../verify/acceptance-profiles"
import {
  createDelegateStepJournal,
  createMemoryDelegateStepJournalStore,
  type DelegateStepJournalStore,
} from "./delegate-step-journal"

export interface DelegateHostPortsInput {
  runId: string
  /** The project the acceptance profile and its approval belong to. */
  projectId: string
  /** The user's checkout: read at the base revision, written only by an approved apply. */
  workspaceRoot: string
  /** The `.cognia/workspace.json` profile the run verifies with. */
  acceptanceProfileId: string
  store: FusionLedgerStore
  now?: () => number
  newId?: () => string
  /** Where `.cognia/workspace.json` is read from; the run's execution root. */
  configRoot?: string | null
  /**
   * An explicit pinned image for the container tier, overriding the project's
   * runtime environment. Without a pinned image from either, that tier is not
   * offered.
   */
  containerImage?: string | null
  /** The project record, for the runtime environment's trust gate. */
  project?: { roots?: unknown } | null
  /** Resource ceilings above the defaults; the profile still owns the timeout. */
  limits?: Partial<Omit<AcceptanceResourceLimits, "timeoutMs">>
  /** Seams: a test drives the real ports against a fake filesystem and sandbox. */
  workspaceHost?: Partial<DelegateWorkspaceHost>
  sandbox?: AcceptanceSandboxHost
  journalStore?: DelegateStepJournalStore
  resolveProfile?: AcceptanceProfileResolver
}

export interface DelegateHostPorts {
  /** Also `dispose()`: the run's two worktrees, given back when it ends. */
  workspace: DelegateWorkspacePort
  acceptance: AcceptancePort
  tools: ToolRuntime & DelegateToolRuntime
  journal: DelegateStepJournal
}

/** The profile resolver over WP-D2, in the shape the acceptance port takes. */
export function acceptanceProfileResolver(
  projectId: string,
  configRoot?: string | null
): AcceptanceProfileResolver {
  return async (profileId) => {
    const resolution = await resolveAcceptanceProfile(projectId, profileId, {
      ...(configRoot === undefined ? {} : { configRoot }),
    })
    return resolution.ok
      ? { ok: true, profile: resolution.profile }
      : { ok: false, code: resolution.code, message: resolution.message }
  }
}

/**
 * Every port a delegate run runs against on this device, sharing one
 * workspace: the acceptance port verifies the very trees the workspace port
 * staged, and the tool runtime reads through the same path and PII rules.
 */
export function createDelegateHostPorts(input: DelegateHostPortsInput): DelegateHostPorts {
  const now = input.now ?? Date.now
  const newId = input.newId ?? (() => crypto.randomUUID())

  const workspace = createDelegateWorkspacePort({
    runId: input.runId,
    workspaceRoot: input.workspaceRoot,
    ...(input.workspaceHost ? { host: input.workspaceHost } : {}),
  })

  const acceptance = createDelegateAcceptancePort({
    runId: input.runId,
    rootForRevision: (revision) => workspace.rootForRevision(revision),
    resolveProfile:
      input.resolveProfile ?? acceptanceProfileResolver(input.projectId, input.configRoot),
    sandbox: input.sandbox ?? defaultAcceptanceSandboxHost(),
    artifacts: input.store.artifactStore(input.runId),
    newId,
    ...(input.limits ? { limits: input.limits } : {}),
    ...(input.containerImage === undefined ? {} : { image: input.containerImage }),
    // ADR-0182: the image the project's runtime environment resolves to,
    // asked for once and only if a container tier is otherwise available.
    resolveImage: () =>
      resolveProjectContainerImage({
        projectId: input.projectId,
        project: input.project ?? null,
        executionRoot: input.configRoot ?? input.workspaceRoot,
      }),
  })

  const tools = createHostToolRuntime({
    store: input.store,
    runId: input.runId,
    // A delegate worker gets no web and no panel file reader: its whole world
    // is the subtask's workspace at the run's revision.
    web: null,
    workspace: null,
    delegate: { workspace },
    now,
  })

  const journal = createDelegateStepJournal({
    runId: input.runId,
    store: input.journalStore ?? createMemoryDelegateStepJournalStore(),
    now,
  })

  return { workspace, acceptance, tools, journal }
}
