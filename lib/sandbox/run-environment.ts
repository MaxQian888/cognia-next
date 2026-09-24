/**
 * Placing one run in its project's runtime environment (ADR-0182).
 *
 * The one call a surface makes before it starts an external agent. It gathers
 * the four things resolution needs — the project's selection, the effective
 * catalog, what the repository declares, and the approval that applies —
 * resolves a spec, turns it into a placement, and parks that placement for the
 * spawn to pick up.
 *
 * # The off path costs nothing
 *
 * A project with no `runtime` selection returns `off` before any other source
 * is touched: no Host call, no filesystem read, no Dexie read, and no
 * `sandbox` field on the spawn (Q39). That is the single most important
 * property here, and it is the first test.
 *
 * # Why the outcome is remembered
 *
 * `registerSpawnPlacement` persists across spawns until the next resolution.
 * The *reason* a run was not placed also outlives the spawn: the manager has to refuse
 * a connect whose environment was refused, and the UI has to say why a run
 * that did start is running unsandboxed. So the outcome is recorded per agent
 * and read back by both.
 *
 * # Which approval counts
 *
 * The Host's ledger is the authority that admission checks, so it is asked
 * first. A device approval (ADR-0147) is accepted only on a Host that is not
 * multi-tenant: on a shared Host, one tenant's device saying "I approve this
 * image" would be a grant nobody with authority over the workspace ever made.
 */

import type { Project } from "@/types"
import type { ApprovedEnvironmentDeclaration } from "@/lib/db/trusted-workspaces"
import { builtEnvironmentDeclaration } from "@/lib/project-environment/devcontainer"
import {
  declarationReader,
  fetchEnvironmentCatalog,
  isPoolDisabled,
  environmentBuildGet,
  type EnvironmentBuildRecord,
  type ApprovalRecord,
  type DeclarationReadResult,
} from "@/lib/project-environment/environment-client"
import { readEnvironmentDeclaration } from "@/lib/project-environment/read-environment-declaration"
import type { EnvironmentDeclarationVerdict } from "@/lib/project-environment/read-environment-declaration"
import {
  deviceApprovalView,
  resolveEnvironmentSpec,
  type EnvironmentApprovalView,
  type EnvironmentRefusalCode,
  type ResolutionSurface,
} from "@/lib/project-environment/resolve-environment-spec"
import {
  approvalKeyFor,
  evaluateWorkspaceConfig,
  type WorkspaceConfigVerdict,
} from "@/lib/project-environment/workspace-config-trust"
import type { EnvironmentCatalogView } from "@/types/sandbox/environment-catalog"

import {
  isolationMandatory,
  sandboxPlacementFrom,
  type PlacementProjectInput,
  type SandboxPlacementOutcome,
} from "./environment-placement"
import {
  clearSpawnPlacement,
  registerSpawnPlacement,
  spawnedPlacementDigest,
} from "./spawn-placement-registry"

export interface RunEnvironmentRequest {
  /** The `ExternalAgentSpawnConfig.id` the placement will be attached to. */
  agentId: string
  projectId: string
  /**
   * The session's project environment (`SessionExecutionContext.environmentId`,
   * seeded from the project's `defaultEnvironmentId`). Absent: the project's
   * default, else its first enabled environment.
   */
  environmentId?: string
  /** The workspace, for the trust gate and the device-approval key. */
  project: Pick<Project, "roots"> | null | undefined
  /** The run's execution root — the branch the run is actually on. */
  executionRoot: string | null | undefined
  surface: ResolutionSurface
  /** The checkout's coordinates. Absent outside a repository. */
  repository?: { remote: string; commitSha: string }
  /** `appSettings.workspaceTrust?.enabled !== false`. Defaults to on. */
  trustEnabled?: boolean
  /** True in the browser, where there is no local filesystem. */
  onWeb?: boolean
}

/**
 * Everything this module reads from outside itself.
 *
 * Injected rather than imported so the composition above is a table test, and
 * so the off path can be *proven* to call none of them.
 */
export interface RunEnvironmentSources {
  /** The project's runtime selection and execution policy. */
  selection: (projectId: string, environmentId?: string) => Promise<PlacementProjectInput>
  catalog: () => Promise<EnvironmentCatalogView>
  /** Every declaration file under the execution root, unparsed. */
  declarationFiles: (root: string) => Promise<DeclarationReadResult>
  workspaceConfig: (
    request: RunEnvironmentRequest,
    readFile: (root: string, relPath: string, maxBytes: number) => Promise<string>
  ) => Promise<WorkspaceConfigVerdict>
  restricted: (request: RunEnvironmentRequest) => Promise<boolean>
  /** The Host's approval ledger for this project. */
  serverApprovals: (projectId: string) => Promise<ApprovalRecord[]>
  buildRecord?: (projectId: string, buildKey: string) => Promise<EnvironmentBuildRecord | undefined>
  /** The device approval (ADR-0147) recorded against the workspace's primary root. */
  deviceApproval: (approvalKey: string) => Promise<ApprovedEnvironmentDeclaration | undefined>
}

/** A catalog that admits nothing, for a Host that could not be read. */
function unreadableCatalog(): EnvironmentCatalogView {
  return {
    poolEnabled: false,
    multiTenant: false,
    floor: "container",
    entries: [],
    rejected: [],
    sizeClasses: [],
    egressPresets: [],
  }
}

/**
 * The approval that applies, from whichever authority may give it.
 *
 * `undefined` means nobody approved this declaration, which the resolver turns
 * into `environment_approval_pending` (unattended) or a notice plus the
 * deployment default (interactive).
 */
export async function applicableApproval(
  request: RunEnvironmentRequest,
  declaration: EnvironmentDeclarationVerdict,
  catalog: EnvironmentCatalogView,
  sources: RunEnvironmentSources
): Promise<EnvironmentApprovalView | undefined> {
  if (declaration.kind !== "declared") return undefined
  const declared = declaration.declaration

  const records = await sources.serverApprovals(request.projectId).catch(() => [])
  const server = records.find(
    (record) =>
      record.revokedAt === undefined &&
      record.declarationDigest === declaration.digest &&
      record.path === declared.path &&
      (declared.build ? record.buildKey !== undefined : record.resolvedImage !== undefined)
  )
  if (server?.buildKey && declared.build) {
    const record = await sources
      .buildRecord?.(request.projectId, server.buildKey)
      .catch(() => undefined)
    if (
      !record ||
      record.projectId !== request.projectId ||
      record.buildKey !== server.buildKey ||
      record.declarationDigest !== declaration.digest ||
      record.declarationPath !== declared.path ||
      record.commitSha !== request.repository?.commitSha.toLowerCase()
    )
      return undefined
    const effective = builtEnvironmentDeclaration(record.runtimeConfiguration, declared)
    if (!effective.ok) return undefined
    return {
      ref: server.id,
      declarationDigest: server.declarationDigest,
      file: declared.file,
      path: server.path,
      builtImage: { kind: "build", buildKey: record.buildKey, imageId: record.imageId },
      buildCommitSha: record.commitSha,
      runtimeDeclaration: effective.declaration,
    }
  }
  if (server?.resolvedImage) {
    return {
      ref: server.id,
      declarationDigest: server.declarationDigest,
      file: declared.file,
      path: server.path,
      resolvedImage: server.resolvedImage,
    }
  }

  // A device cannot approve an image on a Host several tenants share.
  if (catalog.multiTenant) return undefined
  const key = approvalKeyFor(request.project)
  if (!key) return undefined
  const device = await sources.deviceApproval(key).catch(() => undefined)
  // Whether the row still matches the declaration is the resolver's check
  // (`approvalMatches`), so a stale row is passed through and judged there —
  // and becomes the "changed since you approved it" notice rather than
  // vanishing here without a word.
  return deviceApprovalView(key, device)
}

/** Resolve and decide, reading only from `sources`. Registers nothing. */
export async function prepareRunEnvironment(
  request: RunEnvironmentRequest,
  sources: RunEnvironmentSources
): Promise<SandboxPlacementOutcome> {
  const project = await sources.selection(request.projectId, request.environmentId)
  // Q39: nothing selected, nothing read, nothing sent.
  if (project.runtime === undefined) return { kind: "off" }

  // Host eligibility is independent of catalog reachability. An explicit
  // local-container request must not turn into an unsandboxed fallback when
  // the catalog happens to be offline.
  const eligibility = sandboxPlacementFrom({ kind: "off" }, project)
  if (eligibility.kind === "refused") return eligibility

  let catalog: EnvironmentCatalogView
  try {
    catalog = await sources.catalog()
  } catch (error) {
    if (isPoolDisabled(error)) {
      // The deployment never opened the pool. `poolEnabled: false` is the
      // resolver's own vocabulary for that, so it decides fall-back-or-refuse
      // by the same rule as every other caller.
      catalog = unreadableCatalog()
    } else if (isolationMandatory(project)) {
      return { kind: "refused", code: "environment_catalog_unreadable", notices: [] }
    } else {
      return { kind: "fallback", code: "sandbox_fallback_catalog_unreadable", notices: [] }
    }
  }

  const root = request.executionRoot?.trim()
  let declaration: EnvironmentDeclarationVerdict = { kind: "absent" }
  let approvedWorkspaceConfigDigest: string | undefined
  if (root && catalog.poolEnabled) {
    // An unreadable checkout is not an empty declaration. Propagate the Host
    // error so readiness cannot silently start the deployment's default image.
    const files = await sources.declarationFiles(root)
    const readFile = declarationReader(files)
    const workspaceConfig = await sources.workspaceConfig(request, readFile)
    const restricted = await sources.restricted(request)
    declaration = await readEnvironmentDeclaration(
      { root, workspaceConfig, restricted },
      { readFile }
    )
    // Only an APPROVED workspace.json may name setup that runs in the sandbox.
    // An unapproved one is read for its environment block and nothing else.
    if (workspaceConfig.kind === "approved") {
      approvedWorkspaceConfigDigest = workspaceConfig.digest
    }
  }

  const approval = await applicableApproval(request, declaration, catalog, sources)

  const resolution = await resolveEnvironmentSpec({
    projectId: request.projectId,
    runtime: project.runtime,
    policy: project.policy,
    catalog,
    surface: request.surface,
    declaration,
    ...(approval ? { approval } : {}),
    ...(request.repository ? { repository: request.repository } : {}),
    ...(approvedWorkspaceConfigDigest
      ? { workspaceConfigDigest: approvedWorkspaceConfigDigest }
      : {}),
  })

  return sandboxPlacementFrom(resolution, project)
}

/**
 * The last outcome per agent id.
 *
 * Separate from the placement registry because off, fallback and refused
 * outcomes also need to remain readable without granting a spawn placement.
 */
const outcomes = new Map<string, SandboxPlacementOutcome>()
const preparations = new Map<string, symbol>()
const listeners = new Set<(agentId: string, outcome: SandboxPlacementOutcome) => void>()

export function recordRunEnvironmentOutcome(
  agentId: string,
  outcome: SandboxPlacementOutcome
): void {
  outcomes.set(agentId, outcome)
  for (const listener of listeners) listener(agentId, outcome)
}

export function runEnvironmentOutcome(agentId: string): SandboxPlacementOutcome | undefined {
  return outcomes.get(agentId)
}

export function forgetRunEnvironmentOutcome(agentId: string): void {
  preparations.delete(agentId)
  outcomes.delete(agentId)
  clearSpawnPlacement(agentId)
}

/** Be told when an agent's outcome is recorded. Returns an unsubscribe. */
export function onRunEnvironmentOutcome(
  listener: (agentId: string, outcome: SandboxPlacementOutcome) => void
): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function __resetRunEnvironmentForTests(): void {
  preparations.clear()
  outcomes.clear()
  listeners.clear()
}

/**
 * Resolve, park the placement, and remember the outcome.
 *
 * The one entry point for a surface about to start an agent. A `placed`
 * outcome leaves a placement for `withSpawnPlacement` to attach to the next
 * `spawn_external_agent` for this id; every other outcome clears any stale one
 * so a refused run cannot inherit an earlier resolution's authority.
 */
export async function placeAgentRun(
  request: RunEnvironmentRequest,
  sources: RunEnvironmentSources = defaultRunEnvironmentSources()
): Promise<SandboxPlacementOutcome> {
  const { agentId } = request
  const preparation = Symbol(agentId)
  preparations.set(agentId, preparation)
  try {
    const outcome = await prepareRunEnvironment(request, sources)
    if (preparations.get(agentId) !== preparation) {
      throw new DOMException("Environment preparation was superseded", "AbortError")
    }
    if (outcome.kind === "placed") registerSpawnPlacement(agentId, outcome.placement)
    else clearSpawnPlacement(agentId)
    recordRunEnvironmentOutcome(agentId, outcome)
    return outcome
  } catch (cause) {
    // An old failure must not remove a newer run's placement, and the caller
    // must not continue connecting with a superseded resolution.
    if (preparations.get(agentId) !== preparation) {
      throw new DOMException("Environment preparation was superseded", "AbortError")
    }
    outcomes.delete(agentId)
    clearSpawnPlacement(agentId)
    throw cause
  } finally {
    if (preparations.get(agentId) === preparation) preparations.delete(agentId)
  }
}

/**
 * The real sources.
 *
 * Every import is dynamic, so a caller on the off path never loads the Host
 * client, Dexie or the filesystem bridge: `selection` is reached first and
 * short-circuits before any of the others is called.
 */
export function defaultRunEnvironmentSources(): RunEnvironmentSources {
  return {
    buildRecord: async (projectId, buildKey) =>
      (await environmentBuildGet({ projectId, buildKey })).record,
    selection: async (projectId, environmentId) => {
      const [{ listProjectEnvironments }, { useProjectStore }] = await Promise.all([
        import("@/lib/db/project-environments"),
        import("@/stores/project/project-store"),
      ])
      const environments = await listProjectEnvironments(projectId)
      const preferred =
        environmentId ??
        useProjectStore.getState().projects.find((project) => project.id === projectId)
          ?.defaultEnvironmentId
      // The environment a session runs is the one it names, else the
      // project's default. A disabled definition's selection is not a
      // selection: running it would apply a configuration the user switched
      // off.
      const chosen =
        (preferred
          ? environments.find((environment) => environment.id === preferred)
          : undefined) ?? environments.find((environment) => environment.isEnabled)
      if (!chosen?.isEnabled) return { runtime: undefined, policy: undefined }
      return { runtime: chosen.runtime, policy: chosen.policy }
    },
    catalog: () => fetchEnvironmentCatalog(),
    declarationFiles: async (root) => {
      const { environmentDeclarationRead } =
        await import("@/lib/project-environment/environment-client")
      return environmentDeclarationRead(root)
    },
    workspaceConfig: (request, readFile) =>
      evaluateWorkspaceConfig(
        {
          configRoot: request.executionRoot,
          project: request.project,
          trustEnabled: request.trustEnabled !== false,
          onWeb: request.onWeb === true,
        },
        { readFile }
      ),
    restricted: async (request) => {
      const { isWorkspaceRestricted } = await import("@/lib/workspace/trust-gate")
      return isWorkspaceRestricted(request.project, {
        enabled: request.trustEnabled !== false,
        onWeb: request.onWeb === true,
      }).catch(() => true)
    },
    serverApprovals: async (projectId) => {
      const { fetchEnvironmentApprovals } =
        await import("@/lib/project-environment/environment-client")
      return fetchEnvironmentApprovals(projectId)
    },
    deviceApproval: async (approvalKey) => {
      const { getTrustedWorkspace } = await import("@/lib/db/trusted-workspaces")
      return (await getTrustedWorkspace(approvalKey))?.approvedEnvironment
    },
  }
}

/**
 * The spec an outcome places an agent in, `null` for the host.
 *
 * `off` and `fallback` both run on the host; `refused` runs nowhere, and is
 * reported as the host too because nothing that is running can match it.
 */
export function placementDigestOf(outcome: SandboxPlacementOutcome): string | null {
  return outcome.kind === "placed" ? outcome.placement.spec.specDigest : null
}

/**
 * Whether a running agent process was started somewhere other than where
 * `outcome` puts it.
 *
 * A project whose environment changed while its agent kept running would
 * otherwise go on running the old image — or on the host after the project
 * asked for a sandbox. A process with no spawn record was started before the
 * feature was used in this realm, which means on the host.
 */
export function agentNeedsRespawn(agentId: string, outcome: SandboxPlacementOutcome): boolean {
  return (spawnedPlacementDigest(agentId) ?? null) !== placementDigestOf(outcome)
}

/**
 * A connect refused because its runtime environment could not be placed.
 *
 * Carries the code so a surface can localize it and a log can be specific;
 * `message` is already localized because it is what the user reads when the
 * manager surfaces a failed connect.
 */
export class RunEnvironmentRefusedError extends Error {
  readonly code: EnvironmentRefusalCode
  readonly detail?: Record<string, string | number | boolean>

  constructor(
    code: EnvironmentRefusalCode,
    message: string,
    detail?: Record<string, string | number | boolean>
  ) {
    super(message)
    this.name = "RunEnvironmentRefusedError"
    this.code = code
    if (detail) this.detail = detail
  }
}

/**
 * Stop a connect whose environment was refused.
 *
 * The refusal happened during resolution, before any process existed. Letting
 * the connect proceed would start the agent on the ordinary path — which is
 * precisely what the refusal said must not happen, since a refusal is only
 * ever raised when running unsandboxed would silently do less than was asked
 * (Q40).
 *
 * `off`, `fallback` and `placed` all proceed: the first two by design, the
 * third because the placement is already parked for the spawn.
 */
export async function assertRunEnvironmentPlaced(agentId: string): Promise<void> {
  const outcome = runEnvironmentOutcome(agentId)
  if (outcome?.kind !== "refused") return
  // The refusal is raised whether or not it could be worded. A failure to
  // load the message bundle that escaped here would reach the manager as a
  // `TypeError`, which it would retry and report as a connection problem —
  // turning a decision about this project into an unexplained failure.
  const message = await import("./environment-outcome-message")
    .then((module) => module.outcomeMessage(outcome))
    .catch(() => undefined)
  throw new RunEnvironmentRefusedError(outcome.code, message ?? outcome.code, outcome.detail)
}

/**
 * The checkout's coordinates, for a declaration to be pinned to.
 *
 * `origin` if the checkout has one, else its first remote; `HEAD`'s full hash.
 * `undefined` for anything that is not a git checkout with both — the
 * resolver then reports the declaration as unversioned rather than running
 * an image no commit can be traced to.
 */
export async function readRepositoryCoordinates(
  root: string | null | undefined
): Promise<{ remote: string; commitSha: string } | undefined> {
  const path = root?.trim()
  if (!path) return undefined
  const { gitLog, gitRemotes } = await import("@/lib/git/commands")
  const [remotes, head] = await Promise.all([
    gitRemotes(path).catch(() => []),
    gitLog(path, 1, 0).catch(() => []),
  ])
  const remote = (remotes.find((entry) => entry.name === "origin") ?? remotes[0])?.fetchUrl?.trim()
  const commitSha = head[0]?.hash?.trim()
  return remote && commitSha ? { remote, commitSha } : undefined
}
