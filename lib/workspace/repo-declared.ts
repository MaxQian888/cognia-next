/**
 * What a repository declares about the workspace opened on it — and the rule
 * for how much of it Cognia is allowed to just do.
 *
 * # Suggestion versus instruction
 *
 * `.cognia/workspace.json` is committed by whoever wrote the repository, and
 * read on a machine belonging to someone else. Three of its fields describe the
 * workspace rather than a script to run:
 *
 *  - `defaults.execution` / `defaults.base` — "conversations here should get
 *    their own worktree, cut from the remote default branch";
 *  - `roots` — "these sub-packages belong to this workspace too";
 *  - `capabilities` — "this project uses the Jira MCP server".
 *
 * All three are real value: they are what stops a new contributor from having
 * to be told the setup out of band. None of them may overrule a choice the user
 * already made on this device, because the file changes under them on every
 * pull and a setting that silently reverts is worse than one that was never
 * offered.
 *
 * So the rule is **seed once, never re-seed**:
 *
 *  - `defaults.*` apply only where the workspace has no remembered default of
 *    its own. The user's first explicit choice persists onto the project and
 *    outranks the file from then on.
 *  - `roots` and `capabilities` are applied at APPROVAL time — the moment the
 *    user says yes to this exact content — and each declaration is recorded as
 *    offered. Removing a seeded root or clearing a seeded capability sticks,
 *    because the seed key is remembered even after the thing it created is
 *    gone.
 *
 * Nothing here reads an unapproved configuration. `evaluateWorkspaceConfig` is
 * the only door, and it is closed until the user opens it.
 */

import type { Project } from "@/types"
import type { SessionExecutionLocation, SessionWorkspaceBaseSpec } from "@/types/execution-context"
import type { WorkspaceRoot } from "@/types/workspace"

import {
  evaluateWorkspaceConfig,
  type EvaluateWorkspaceConfigDeps,
  type WorkspaceConfigVerdict,
} from "@/lib/project-environment/workspace-config-trust"
import type {
  WorkspaceConfigCapabilities,
  WorkspaceConfigRoot,
  WorkspaceRepositoryConfigV1,
} from "@/lib/project-environment/workspace-config"
import {
  WORKSPACE_CAPABILITY_KINDS,
  withCapabilityState,
  type WorkspaceCapabilityKind,
  type WorkspaceCapabilityOverlay,
} from "./capability-overlay"
import { normalizeRoots, primaryRootOf } from "./roots"

export interface DeclaredWorkspace {
  /** Mapped from the config's `local` / `worktree`. */
  executionLocation: SessionExecutionLocation
  base: SessionWorkspaceBaseSpec
  roots: WorkspaceConfigRoot[]
  capabilities: WorkspaceConfigCapabilities
}

/**
 * `worktree` in the file, `managedWorktree` in the execution context.
 *
 * Two names for one thing is a translation, not a synonym: the file describes
 * intent ("run this somewhere of its own") while the context names the specific
 * mechanism Cognia uses for it.
 */
export function declaredExecutionLocation(
  config: Pick<WorkspaceRepositoryConfigV1, "defaults">
): SessionExecutionLocation {
  return config.defaults.execution === "worktree" ? "managedWorktree" : "local"
}

export function declaredWorkspaceOf(config: WorkspaceRepositoryConfigV1): DeclaredWorkspace {
  return {
    executionLocation: declaredExecutionLocation(config),
    base: config.defaults.base as SessionWorkspaceBaseSpec,
    roots: config.roots,
    capabilities: config.capabilities,
  }
}

/**
 * The declared workspace, but only when the user has approved this exact
 * content. Returns null for every other verdict — including "unreadable",
 * because a broken file must not half-apply.
 */
export async function loadDeclaredWorkspace(
  project: Pick<Project, "roots"> | null | undefined,
  options: { configRoot?: string | null; trustEnabled: boolean; onWeb: boolean },
  deps?: Partial<EvaluateWorkspaceConfigDeps>
): Promise<DeclaredWorkspace | null> {
  const configRoot = options.configRoot?.trim() || primaryRootOf(project ?? { roots: [] })?.path
  if (!configRoot) return null
  const verdict: WorkspaceConfigVerdict = await evaluateWorkspaceConfig(
    {
      configRoot,
      project,
      trustEnabled: options.trustEnabled,
      onWeb: options.onWeb,
    },
    deps
  ).catch(() => ({ kind: "absent" }) as WorkspaceConfigVerdict)
  return verdict.kind === "approved" ? declaredWorkspaceOf(verdict.config) : null
}

// ── Seeding ────────────────────────────────────────────────────────────────

/** Stable identity of one declaration, remembered even after it is removed. */
export function capabilitySeedKey(kind: WorkspaceCapabilityKind, id: string): string {
  return `cap:${kind}:${id}`
}

/** Roots are keyed by their DECLARED id, not their path — a repository may move one. */
export function rootSeedKey(declaredId: string): string {
  return `root:${declaredId}`
}

/** `WorkspaceRoot.id` for a seeded root, so its provenance is visible on the row. */
export function seededRootId(declaredId: string): string {
  return `repo-${declaredId}`
}

export interface SeedDeclarationsInput {
  declared: DeclaredWorkspace
  /** The workspace's current overlay. */
  overlay: WorkspaceCapabilityOverlay | null | undefined
  /** The workspace's current roots. */
  roots: readonly WorkspaceRoot[]
  /** Declarations already offered on this device, from the trust row. */
  alreadySeeded: readonly string[]
  /** Absolute base the declared relative paths hang off. */
  repositoryRoot: string
}

export interface SeededDeclarations {
  overlay: WorkspaceCapabilityOverlay
  roots: WorkspaceRoot[]
  /** The full seeded set to persist — previous entries plus the new ones. */
  seeded: string[]
  /** Whether anything actually changed. Callers skip the write when false. */
  changed: boolean
}

function joinRepoPath(base: string, relative: string): string {
  const trimmed = base.replace(/[\\/]+$/, "")
  const rel = relative.replace(/^[./\\]+/, "")
  return rel ? `${trimmed}/${rel}` : trimmed
}

/**
 * Apply a repository's declarations where the workspace has no opinion.
 *
 * Pure. The caller persists `overlay`, `roots` and `seeded` together — they are
 * one decision, and writing the seed record without the thing it seeded would
 * lose the suggestion permanently.
 */
export function seedDeclarations(input: SeedDeclarationsInput): SeededDeclarations {
  const seeded = new Set(input.alreadySeeded)
  let overlay: WorkspaceCapabilityOverlay = input.overlay ?? {}
  let changed = false

  for (const kind of WORKSPACE_CAPABILITY_KINDS) {
    const declared = input.declared.capabilities[kind]
    if (!declared) continue
    for (const [id, state] of Object.entries(declared)) {
      const key = capabilitySeedKey(kind, id)
      // Offered before: whatever the user did with it since — including
      // clearing it back to "inherit" — is their answer, and re-seeding would
      // overturn it on the next pull.
      if (seeded.has(key)) continue
      // A workspace that already has an explicit opinion is not "no opinion",
      // even if it was set a second ago by the user in another panel.
      if (overlay[kind] && id in (overlay[kind] as Record<string, boolean>)) {
        seeded.add(key)
        changed = true
        continue
      }
      overlay = withCapabilityState(overlay, kind, id, state ? "on" : "off")
      seeded.add(key)
      changed = true
    }
  }

  const existingPaths = new Set(input.roots.map((root) => root.path))
  const nextRoots = [...input.roots]
  for (const declared of input.declared.roots) {
    // The primary root is the workspace's own mount, not something a
    // repository adds — declaring it is how a config describes itself, and
    // adding a second copy of the folder the user already opened is noise.
    if (declared.role === "primary") continue
    const key = rootSeedKey(declared.id)
    if (seeded.has(key)) continue
    const path = joinRepoPath(input.repositoryRoot, declared.path)
    seeded.add(key)
    changed = true
    if (existingPaths.has(path)) continue
    existingPaths.add(path)
    nextRoots.push({ id: seededRootId(declared.id), path, label: declared.id })
  }

  return {
    overlay,
    roots: changed ? normalizeRoots(nextRoots) : [...input.roots],
    seeded: [...seeded],
    changed,
  }
}
