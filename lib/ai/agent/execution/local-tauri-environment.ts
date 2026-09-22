import type { AgentTeamEvidenceKind } from "@/types/agent/agent-team-runtime"
import type { ProjectEnvironment, ProjectEnvironmentVersion } from "@/types/project-environment"
import type { WorkspaceBundleTurnLease } from "@/lib/task-workspace/run-lease"
import type {
  AcquireWorkspaceBundle,
  BeginTaskWorkspaceTurn,
  WorkspaceBundle,
} from "@/lib/task-workspace/types"

export type AgentExecutionEnvironmentCapability =
  ProjectEnvironmentVersion["policy"]["requiredRuntimeCapabilities"][number]

export interface PreparedAgentEnvironment {
  profile: Readonly<ProjectEnvironmentVersion>
  executionRoot: string
  preparedAt: number
}

export interface OpenAgentChildInput {
  runId: string
  childRunId: string
  taskId: string
  teammateId: string
  repositoryPath: string
  profile: PreparedAgentEnvironment
}

export interface AgentChildEnvironmentSession {
  childRunId: string
  executionRoot: string
  workspaceRunId?: string
  branch?: string
  state: "running" | "suspended" | "terminated"
  openedAt: number
  settle(finalState: "ready" | "failed" | "cancelled"): Promise<unknown[]>
}

export interface AgentExecutionEnvironment {
  capabilities(): ReadonlySet<AgentExecutionEnvironmentCapability>
  preflight(profile: ProjectEnvironmentVersion): { ok: boolean; missing: string[] }
  prepare(
    profile: ProjectEnvironmentVersion,
    repositoryPath: string
  ): Promise<PreparedAgentEnvironment>
  openChild(input: OpenAgentChildInput): Promise<AgentChildEnvironmentSession>
  suspend(childRunId: string): Promise<void>
  resume(childRunId: string): Promise<void>
  terminate(childRunId: string): Promise<void>
  dispose(childRunId: string): Promise<void>
  getInteractiveSurfaces(childRunId: string): {
    terminal: { cwd: string; sessionScope: string }
    editor: { root: string }
    browser: { sessionScope: string }
  } | null
  collectEvidence(childRunId: string): Promise<
    Array<{
      kind: AgentTeamEvidenceKind
      title: string
      content?: string | Uint8Array
      url?: string
      status?: "passed" | "failed" | "unknown"
      revision?: string
    }>
  >
  resourceHealth(childRunId: string): {
    state: AgentChildEnvironmentSession["state"]
    wallTimeMs: number
  } | null
}

interface OpenWorkspaceResult {
  executionRoot: string
  workspaceRunId?: string
  branch?: string
  settle(finalState: "ready" | "failed" | "cancelled"): Promise<unknown>
}

type AcquireBundle = (input: AcquireWorkspaceBundle) => Promise<WorkspaceBundle>
type OpenBundleTurn = (
  bundle: Pick<WorkspaceBundle, "bundleId" | "leases">,
  primaryLogicalRootId: string,
  input: BeginTaskWorkspaceTurn
) => Promise<WorkspaceBundleTurnLease | null>

export interface LocalTauriEnvironmentOptions {
  isTauri?: () => boolean
  sandboxSupported?: boolean
  networkPolicySupported?: boolean
  probeConfinement?: () => Promise<{ confined: boolean }>
  now?: () => number
  executeSetup?: (
    profile: ProjectEnvironmentVersion,
    repositoryPath: string
  ) => Promise<{ success: boolean; error?: string }>
  openWorkspace?: (input: OpenAgentChildInput) => Promise<OpenWorkspaceResult>
  acquireWorkspaceBundle?: AcquireBundle
  openWorkspaceBundleTurnLease?: OpenBundleTurn
  collectEvidence?: AgentExecutionEnvironment["collectEvidence"]
}

function asMutableEnvironment(profile: ProjectEnvironmentVersion): ProjectEnvironment {
  return {
    id: profile.environmentId,
    projectId: profile.projectId,
    name: profile.name,
    isEnabled: true,
    setupScript: profile.setupScript,
    actions: profile.actions,
    variables: profile.variables,
    keyringReferences: profile.keyringReferences,
    policy: profile.policy,
    createdAt: profile.createdAt,
    updatedAt: profile.createdAt,
  }
}

export function createLocalTauriExecutionEnvironment(
  options: LocalTauriEnvironmentOptions = {}
): AgentExecutionEnvironment {
  const now = options.now ?? Date.now
  let confinementProven = false
  const openingChildren = new Set<string>()
  const sessions = new Map<
    string,
    AgentChildEnvironmentSession & { settle: OpenWorkspaceResult["settle"] }
  >()
  const capabilities = (): ReadonlySet<AgentExecutionEnvironmentCapability> => {
    const values: AgentExecutionEnvironmentCapability[] = [
      "filesystem",
      "process",
      "terminal",
      "editor",
      "browser",
    ]
    if (options.sandboxSupported ?? confinementProven) values.push("sandbox")
    if (options.networkPolicySupported ?? confinementProven) values.push("network_policy")
    return new Set(values)
  }

  const preflight = (profile: ProjectEnvironmentVersion): { ok: boolean; missing: string[] } => {
    const required = new Set(profile.policy.requiredRuntimeCapabilities)
    const restrictNetwork =
      profile.policy.network === "off" ||
      profile.policy.network === "allowlist" ||
      (profile.policy.allowedDomains?.length ?? 0) > 0
    if (profile.policy.requireSandbox || restrictNetwork) required.add("sandbox")
    if (restrictNetwork) required.add("network_policy")
    const available = capabilities()
    const missing = [...required].filter((capability) => !available.has(capability)).sort()
    return { ok: missing.length === 0, missing }
  }

  const executeSetup =
    options.executeSetup ??
    (async (profile: ProjectEnvironmentVersion, repositoryPath: string) => {
      const { executeProjectEnvironment } = await import("@/lib/project-environment/executor")
      return executeProjectEnvironment({
        environment: asMutableEnvironment(profile),
        executionRoot: repositoryPath,
        scope: "managedWorktree",
        surface: "scheduled",
      })
    })

  const openWorkspace =
    options.openWorkspace ??
    (async (input: OpenAgentChildInput): Promise<OpenWorkspaceResult> => {
      const acquireBundle =
        options.acquireWorkspaceBundle ??
        (await import("@/lib/task-workspace/client")).acquireWorkspaceBundle
      const openBundleTurn =
        options.openWorkspaceBundleTurnLease ??
        (await import("@/lib/task-workspace/run-lease")).openWorkspaceBundleTurnLease
      const primaryLogicalRootId = "primary"
      const { provisioningForWorkspaceRoot } =
        await import("@/lib/task-workspace/workspace-provisioning")
      const provisioning = await provisioningForWorkspaceRoot(input.repositoryPath).catch(
        () => undefined
      )
      const bundle = await acquireBundle({
        ownerType: "team",
        ownerRef: input.runId,
        environmentKind: "managed",
        base: { kind: "remoteDefault" },
        roots: [
          {
            logicalRootId: primaryLogicalRootId,
            role: "primary",
            sourceRoot: input.repositoryPath,
          },
        ],
        ...(provisioning ? { provisioning } : {}),
      })
      const lease = await openBundleTurn(bundle, primaryLogicalRootId, {
        taskId: input.taskId,
        sessionId: input.runId,
        runId: input.childRunId,
        executionRunId: input.runId,
        turnId: input.childRunId,
        attemptId: "a1",
        surface: "agent-team-durable",
        agentId: input.teammateId,
        agentKind: "agent-team",
        workspaceRoot: input.repositoryPath,
      })
      if (!lease) {
        throw new Error("Registry did not return a Bundle Turn execution root")
      }
      return {
        executionRoot: lease.run.executionRoot,
        workspaceRunId: lease.run.runId,
        ...(lease.run.isolationKind === "gitWorktree" && lease.run.isolationRef
          ? { branch: lease.run.isolationRef }
          : {}),
        settle: lease.settle,
      }
    })

  return {
    capabilities,
    preflight,

    async prepare(profile, repositoryPath) {
      const requested = profile.policy
      if (
        (options.sandboxSupported === undefined || options.networkPolicySupported === undefined) &&
        (requested.requireSandbox ||
          requested.network === "off" ||
          requested.network === "allowlist" ||
          (requested.allowedDomains?.length ?? 0) > 0 ||
          requested.requiredRuntimeCapabilities.some(
            (value) => value === "sandbox" || value === "network_policy"
          ))
      ) {
        const probe =
          options.probeConfinement ??
          (async () => (await import("@/lib/ai/code-mode/sandbox-status")).codeSandboxStatus())
        confinementProven = (await probe()).confined === true
      }
      const check = preflight(profile)
      if (!check.ok) {
        throw new Error(`Execution environment cannot enforce: ${check.missing.join(", ")}`)
      }
      const result = await executeSetup(profile, repositoryPath)
      if (!result.success) throw new Error(result.error ?? "Project environment setup failed")
      const snapshot = structuredClone(profile)
      return { profile: Object.freeze(snapshot), executionRoot: repositoryPath, preparedAt: now() }
    },

    async openChild(input) {
      if (openingChildren.has(input.childRunId) || sessions.has(input.childRunId)) {
        throw new Error(`Environment child is already open: ${input.childRunId}`)
      }
      openingChildren.add(input.childRunId)
      try {
        const workspace = await openWorkspace(input)
        let settled = false
        let settlement: unknown[] = []
        let settling: Promise<unknown[]> | undefined
        let settlementState: "ready" | "failed" | "cancelled" | undefined
        const session = {
          childRunId: input.childRunId,
          executionRoot: workspace.executionRoot,
          ...(workspace.workspaceRunId ? { workspaceRunId: workspace.workspaceRunId } : {}),
          ...(workspace.branch ? { branch: workspace.branch } : {}),
          state: "running" as const,
          openedAt: now(),
          async settle(finalState: "ready" | "failed" | "cancelled") {
            if (settled) return settlement
            if (settling) return settling
            // An ambiguous failed settlement must retry the same terminal intent.
            settlementState ??= finalState
            settling = (async () => {
              const result = await workspace.settle(settlementState!)
              settlement = Array.isArray(result) ? result : result === undefined ? [] : [result]
              settled = true
              return settlement
            })()
            try {
              return await settling
            } finally {
              settling = undefined
            }
          },
        }
        sessions.set(input.childRunId, session)
        return session
      } finally {
        openingChildren.delete(input.childRunId)
      }
    },

    async suspend(childRunId) {
      const session = sessions.get(childRunId)
      if (!session) throw new Error(`Unknown environment child: ${childRunId}`)
      if (session.state === "terminated") throw new Error("Terminated child cannot suspend")
      session.state = "suspended"
    },

    async resume(childRunId) {
      const session = sessions.get(childRunId)
      if (!session) throw new Error(`Unknown environment child: ${childRunId}`)
      if (session.state === "terminated") throw new Error("Terminated child cannot resume")
      session.state = "running"
    },

    async terminate(childRunId) {
      const session = sessions.get(childRunId)
      if (!session) return
      session.state = "terminated"
      await session.settle("cancelled")
    },

    async dispose(childRunId) {
      const session = sessions.get(childRunId)
      if (!session) return
      await session.settle(session.state === "terminated" ? "cancelled" : "ready")
      sessions.delete(childRunId)
    },

    getInteractiveSurfaces(childRunId) {
      const session = sessions.get(childRunId)
      if (!session) return null
      return {
        terminal: { cwd: session.executionRoot, sessionScope: childRunId },
        editor: { root: session.executionRoot },
        browser: { sessionScope: childRunId },
      }
    },

    collectEvidence: options.collectEvidence ?? (async () => []),

    resourceHealth(childRunId) {
      const session = sessions.get(childRunId)
      return session
        ? { state: session.state, wallTimeMs: Math.max(0, now() - session.openedAt) }
        : null
    },
  }
}
