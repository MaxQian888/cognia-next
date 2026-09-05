/**
 * Whether a Squad can dispatch right now, and if not, exactly why.
 *
 * ADR-0168 removed the runtime selector, so there is no legacy path for a
 * Squad that is missing what the durable coordinator needs. Instead of failing
 * inside `runTeamLifecycle` with an English `Error`, the gap is computed here
 * as a list of stable blocker codes. A blocked Squad stays visible and
 * editable everywhere. Only `startSquadRun` refuses it, and it refuses with
 * the same codes, so the settings panel, the fleet inspector, a chat card and
 * the CLI all say the same thing.
 *
 * Pure evaluation over injected readers. The default readers touch Dexie and
 * the host profile, and every one of them is replaceable so the rules can be
 * pinned without a database.
 */

import type { AgentTeam, AgentTeammate } from "@/types/agent/agent-team"
import type { ProjectEnvironmentVersion } from "@/types/project-environment"

export type SquadReadinessBlockerCode =
  /** No `repositories[]` entry with `role: "primary"`. */
  | "missing_primary_repository"
  /** More than one primary binding. The migration never produces this. */
  | "ambiguous_primary_repository"
  /** No `environmentRef`. */
  | "missing_environment_ref"
  /** The referenced environment version no longer exists, or belongs to another environment. */
  | "environment_not_found"
  /** The host cannot honour the environment's required capabilities (sandbox, network policy). */
  | "environment_unenforceable"
  /** This host has no Registry workspace controller (no native filesystem). */
  | "workspace_controller_unavailable"
  /** This process is not the authoritative host. A companion must ask the desktop. */
  | "host_unavailable"
  /** The roster has no worker teammate. */
  | "no_teammates"

/** What a surface can offer to clear the blocker. */
export type SquadReadinessAction =
  "configure_repository" | "configure_environment" | "add_teammate" | "open_on_host"

export interface SquadReadinessBlocker {
  code: SquadReadinessBlockerCode
  action?: SquadReadinessAction
  /** Structured, non-sensitive detail for the localized sentence. */
  detail?: {
    environmentId?: string
    versionId?: string
    repositoryIds?: string[]
    missingCapabilities?: string[]
  }
}

export interface SquadReadiness {
  ready: boolean
  blockers: SquadReadinessBlocker[]
  evaluatedAt: number
}

type Preflight = { ok: boolean; missing: string[] }

export interface SquadReadinessDeps {
  getEnvironmentVersion?: (versionId: string) => Promise<ProjectEnvironmentVersion | undefined>
  preflight?: (profile: ProjectEnvironmentVersion) => Preflight | Promise<Preflight>
  /** Whether THIS process may run the coordinator. Desktop and headless say yes. */
  hostIsAuthoritative?: () => boolean | Promise<boolean>
  /** Whether the Registry workspace controller exists here. */
  workspaceControllerAvailable?: () => boolean | Promise<boolean>
  now?: () => number
}

export interface EvaluateSquadReadinessInput {
  team: Pick<AgentTeam, "id" | "config">
  /** The roster. Omit to skip the teammate rule (a definition-only check). */
  teammates?: readonly Pick<AgentTeammate, "role">[]
}

async function defaultGetEnvironmentVersion(
  versionId: string
): Promise<ProjectEnvironmentVersion | undefined> {
  const { getProjectEnvironmentVersion } = await import("@/lib/db/project-environments")
  return getProjectEnvironmentVersion(versionId)
}

async function defaultPreflight(profile: ProjectEnvironmentVersion): Promise<Preflight> {
  // Lazy import keeps this module a leaf for the pure callers.
  const { createLocalTauriExecutionEnvironment } =
    await import("@/lib/ai/agent/execution/local-tauri-environment")
  return createLocalTauriExecutionEnvironment().preflight(profile)
}

async function defaultHostIsAuthoritative(): Promise<boolean> {
  const { detectHostProfile } = await import("@/lib/platform/capabilities")
  const profile = detectHostProfile()
  return profile === "desktop" || profile === "headless"
}

function defaultWorkspaceControllerAvailable(): Promise<boolean> {
  // The Registry controller opens dispatch leases through the native task
  // workspace crate, which only the desktop and headless hosts carry.
  return defaultHostIsAuthoritative()
}

/**
 * Evaluate readiness. Blockers are ordered from the cheapest to fix to the
 * most structural, so the first one is the one to show when only one fits.
 */
export async function evaluateSquadReadiness(
  input: EvaluateSquadReadinessInput,
  deps: SquadReadinessDeps = {}
): Promise<SquadReadiness> {
  const now = deps.now ?? Date.now
  const blockers: SquadReadinessBlocker[] = []
  const config = input.team.config

  if (input.teammates && !input.teammates.some((member) => member.role === "teammate")) {
    blockers.push({ code: "no_teammates", action: "add_teammate" })
  }

  const primaries = (config.repositories ?? []).filter(
    (repository) => repository.role === "primary"
  )
  if (primaries.length === 0) {
    blockers.push({ code: "missing_primary_repository", action: "configure_repository" })
  } else if (primaries.length > 1) {
    blockers.push({
      code: "ambiguous_primary_repository",
      action: "configure_repository",
      detail: { repositoryIds: primaries.map((repository) => repository.id) },
    })
  }

  const ref = config.environmentRef
  if (!ref) {
    blockers.push({ code: "missing_environment_ref", action: "configure_environment" })
  } else {
    const version = await (deps.getEnvironmentVersion ?? defaultGetEnvironmentVersion)(
      ref.versionId
    ).catch(() => undefined)
    if (!version || version.environmentId !== ref.environmentId) {
      blockers.push({
        code: "environment_not_found",
        action: "configure_environment",
        detail: { environmentId: ref.environmentId, versionId: ref.versionId },
      })
    } else {
      const check = await (deps.preflight ?? defaultPreflight)(version)
      if (!check.ok) {
        blockers.push({
          code: "environment_unenforceable",
          action: "configure_environment",
          detail: {
            environmentId: ref.environmentId,
            versionId: ref.versionId,
            missingCapabilities: [...check.missing],
          },
        })
      }
    }
  }

  const authoritative = await (deps.hostIsAuthoritative ?? defaultHostIsAuthoritative)()
  if (!authoritative) {
    blockers.push({ code: "host_unavailable", action: "open_on_host" })
  } else if (
    !(await (deps.workspaceControllerAvailable ?? defaultWorkspaceControllerAvailable)())
  ) {
    blockers.push({ code: "workspace_controller_unavailable", action: "open_on_host" })
  }

  return { ready: blockers.length === 0, blockers, evaluatedAt: now() }
}

/** Every blocker code, in display order. Pinned by the i18n coverage test. */
export const SQUAD_READINESS_BLOCKER_CODES: readonly SquadReadinessBlockerCode[] = [
  "no_teammates",
  "missing_primary_repository",
  "ambiguous_primary_repository",
  "missing_environment_ref",
  "environment_not_found",
  "environment_unenforceable",
  "host_unavailable",
  "workspace_controller_unavailable",
]
