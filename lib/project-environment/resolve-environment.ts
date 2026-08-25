/**
 * The one place a run's project environment is assembled.
 *
 * # What was missing
 *
 * `lib/project-environment/workspace-config.ts` — the parser, the validator and
 * the merge for `.cognia/workspace.json` — was written in full, tested, and
 * called by nothing. Two surfaces load a `ProjectEnvironment` before a turn
 * (the chat controller and the scheduler executor) and both used the raw
 * device-local row, so a repository could describe its own setup and Cognia
 * would never look.
 *
 * This is the seam that closes it, and it exists as a seam rather than as two
 * inline blocks for a specific reason: the repository configuration is gated
 * (see `workspace-config-trust`), and a gate duplicated at two call sites is a
 * gate that will eventually be applied at one.
 *
 * # It always returns something runnable
 *
 * Every path that does not end in an approved configuration returns the
 * device-local environment unchanged — which is exactly the behaviour before
 * any of this existed. The verdict rides along so the caller can say what
 * happened; the failure mode this shape rules out is a turn that quietly does
 * less than the repository asked for.
 */

import type { Project } from "@/types"
import type { ProjectEnvironment } from "@/types/project-environment"
import { isTauri } from "@/lib/tauri"

import { mergeWorkspaceConfig } from "./workspace-config"
import {
  evaluateWorkspaceConfig,
  verdictNeedsAttention,
  type EvaluateWorkspaceConfigDeps,
  type WorkspaceConfigVerdict,
} from "./workspace-config-trust"

export interface EnvironmentForRun {
  /** What to hand `executeProjectEnvironment`. */
  environment: ProjectEnvironment
  verdict: WorkspaceConfigVerdict
  /** Repository-required variables with no keyring binding on this device. */
  missingSecretVariables: string[]
  /** Repository variables this device overrides. See `mergeWorkspaceConfig`. */
  overriddenVariables: string[]
}

export interface ResolveEnvironmentInput {
  environment: ProjectEnvironment
  /**
   * Where to read `.cognia/workspace.json` from — the run's execution root, so
   * the configuration matches the branch the run is actually on.
   */
  executionRoot: string | null | undefined
  /** The workspace, for the trust decision and the approval key. */
  project?: Pick<Project, "roots"> | null
  /** Which surface asked, for the notification's wording. */
  surface: "interactive" | "scheduled"
  /** The workspace id, so a notification can name where it came from. */
  projectId?: string
}

export interface ResolveEnvironmentDeps extends Partial<EvaluateWorkspaceConfigDeps> {
  loadProject: (projectId: string | undefined) => Promise<Pick<Project, "roots"> | null>
  trustEnabled: () => Promise<boolean>
  onWeb: () => boolean
  /** Fire-and-forget report. See `reportOnce`. */
  report: (input: {
    verdict: WorkspaceConfigVerdict
    projectId?: string
    surface: "interactive" | "scheduled"
  }) => void
  now: () => number
}

/**
 * Verdicts already reported this app run, keyed by workspace + content.
 *
 * A turn resolves its environment every time it runs. Without this, a
 * repository configuration awaiting approval would raise a notification on
 * every single message — which trains the user to dismiss precisely the thing
 * they need to read. Keyed by content, so an edited configuration is a new
 * report rather than a suppressed one.
 *
 * In-memory on purpose: surviving a restart would mean a user who dismissed
 * the notification and restarted never hears about it again.
 */
const reported = new Set<string>()

/** Test seam — the module-scoped dedupe would otherwise leak between cases. */
export function __resetWorkspaceConfigReports(): void {
  reported.clear()
}

function reportKey(verdict: WorkspaceConfigVerdict, projectId?: string): string {
  const scope = projectId ?? "-"
  switch (verdict.kind) {
    case "unapproved":
      return `${scope}:unapproved:${verdict.digest}`
    case "invalid":
      return `${scope}:invalid:${verdict.field}:${verdict.message}`
    case "restricted":
      return `${scope}:restricted`
    default:
      return `${scope}:${verdict.kind}`
  }
}

/**
 * Every field lazy: a caller that injects all of them (tests, and the plugin
 * host) must not drag the settings store and Dexie in behind them.
 */
const DEFAULT_DEPS: ResolveEnvironmentDeps = {
  loadProject: async (projectId) => {
    if (!projectId) return null
    const { useProjectStore } = await import("@/stores/project/project-store")
    const fromStore = useProjectStore.getState().projects.find((p) => p.id === projectId)
    if (fromStore) return fromStore
    // The scheduler can fire before the project store hydrates, and a trust
    // decision made against "no roots" reads as trusted.
    const { getAllProjects } = await import("@/lib/db/projects")
    const rows = await getAllProjects().catch(() => [])
    return rows.find((p) => p.id === projectId) ?? null
  },
  trustEnabled: async () => {
    try {
      const { useSettingsStore } = await import("@/stores/settings")
      return useSettingsStore.getState().settings?.workspaceTrust?.enabled !== false
    } catch {
      // Unreadable settings must never be the thing that disables the gate.
      return true
    }
  },
  onWeb: () => !isTauri(),
  report: (input) => void reportWorkspaceConfig(input).catch(() => {}),
  now: () => Date.now(),
}

/**
 * Raise the notification for a verdict that needs the user.
 *
 * `warning`, not `error`: nothing failed — the run proceeded on the device-local
 * environment. What is true is that the repository asked for something and did
 * not get it, and only the user can change that.
 */
async function reportWorkspaceConfig(input: {
  verdict: WorkspaceConfigVerdict
  projectId?: string
  surface: "interactive" | "scheduled"
}): Promise<void> {
  const [{ notify }, { getRuntimeTranslator }] = await Promise.all([
    import("@/lib/notifications/runtime"),
    import("@/lib/i18n/runtime-translator"),
  ])
  const t = await getRuntimeTranslator("projectEnvironment.repoConfig.notify")
  const kind = input.verdict.kind
  if (kind !== "unapproved" && kind !== "invalid" && kind !== "restricted") return
  const body =
    input.verdict.kind === "invalid"
      ? t("invalid.body", { message: input.verdict.message, field: input.verdict.field })
      : input.verdict.kind === "unapproved" && input.verdict.approvedDigest
        ? t("changed.body")
        : t(`${kind}.body`)
  const titleKey =
    input.verdict.kind === "unapproved" && input.verdict.approvedDigest ? "changed" : kind
  await notify({
    source: "system",
    level: "warning",
    title: t(`${titleKey}.title`),
    body,
    href: "/settings",
    // One row per workspace and kind. A configuration awaiting approval is a
    // standing fact, not an event — a second copy of it is noise.
    dedupeKey: `workspace-config:${input.projectId ?? "-"}:${titleKey}`,
    ...(input.projectId ? { projectId: input.projectId } : {}),
  })
}

export async function resolveEnvironmentForRun(
  input: ResolveEnvironmentInput,
  overrides?: Partial<ResolveEnvironmentDeps>
): Promise<EnvironmentForRun> {
  const deps: ResolveEnvironmentDeps = { ...DEFAULT_DEPS, ...overrides }
  const project = input.project ?? (await deps.loadProject(input.projectId).catch(() => null))

  const verdict = await evaluateWorkspaceConfig(
    {
      configRoot: input.executionRoot,
      project,
      trustEnabled: await deps.trustEnabled(),
      onWeb: deps.onWeb(),
    },
    overrides
  ).catch((cause): WorkspaceConfigVerdict => ({
    kind: "invalid",
    message: cause instanceof Error ? cause.message : String(cause),
    field: "workspace.json",
  }))

  if (verdictNeedsAttention(verdict)) {
    const key = reportKey(verdict, input.projectId)
    if (!reported.has(key)) {
      reported.add(key)
      deps.report({
        verdict,
        surface: input.surface,
        ...(input.projectId ? { projectId: input.projectId } : {}),
      })
    }
  }

  if (verdict.kind !== "approved") {
    return {
      environment: input.environment,
      verdict,
      missingSecretVariables: [],
      overriddenVariables: [],
    }
  }

  const merged = mergeWorkspaceConfig(input.environment, verdict.config, deps.now())
  return {
    environment: merged.environment,
    verdict,
    missingSecretVariables: merged.missingSecretVariables,
    overriddenVariables: merged.overriddenVariables,
  }
}
