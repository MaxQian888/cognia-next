/**
 * What this device can actually do for a delegate request (ADR-0188 D15/D16,
 * WP-D4), asked once per route.
 *
 * The action router excludes a delegate action unless BOTH hold
 * (`routing/action-router.ts`):
 *
 * - `sandboxTier` — the strongest isolation available here, in the contract's
 *   order (microVM → container → OS). A device with none gets
 *   `SANDBOX_UNAVAILABLE`, which is the whole point: generated code is never
 *   run unconfined because no sandbox was around. The container tier is
 *   currently never offered (deferred), and the Windows OS tier reports itself
 *   unavailable rather than pretending, so those machines route away from
 *   delegate instead of running tests outside a jail.
 * - `acceptanceProfileAvailable` — the project declares an acceptance command
 *   in `.cognia/workspace.json` AND the user approved it at its current hash
 *   (WP-D2). An unapproved profile is not "available": it is a decision
 *   nobody has made yet.
 *
 * What the ROUTER is told is what could be chosen. What the RUN records is
 * what the sandbox runner attested it actually used — `VerificationReport`'s
 * tier comes from the runner, never from this answer, so a tier that
 * disappeared between routing and running cannot be claimed.
 *
 * Everything here is loaded through a dynamic `import()` from `run-route.ts`,
 * and only for a request that could reach delegate: a cascade or a panel
 * request never pays for the sandbox probe or the project read.
 */

import type { SandboxTier } from "@cognia/router-fusion"

export interface DelegateCapabilities {
  /** The strongest tier available now, or null when nothing can confine a run. */
  sandboxTier: SandboxTier | null
  /** A profile exists for this project and is approved at its current hash. */
  acceptanceProfileAvailable: boolean
  /** The ids a request may name in `acceptance_profile_id`. */
  approvedProfileIds: string[]
  /** Why nothing is available, for the refusal's reasons. */
  reason: string | null
}

export const DELEGATE_UNAVAILABLE: DelegateCapabilities = {
  sandboxTier: null,
  acceptanceProfileAvailable: false,
  approvedProfileIds: [],
  reason: "no_project",
}

export interface DelegateCapabilityDeps {
  /** Test seam: the tier this device reports. */
  sandboxTier?: () => Promise<SandboxTier | null>
  /** Test seam: the project's acceptance profiles. */
  acceptanceProfiles?: (
    projectId: string
  ) => Promise<{ available: boolean; approvedProfileIds: string[]; reason: string | null }>
}

/**
 * The project's primary root — the checkout a delegate run stages from.
 *
 * `approvalKeyFor` is the same function the acceptance-profile trust store
 * keys approvals on (WP-D2), so the root a run works in and the root an
 * approval was recorded against cannot drift apart.
 */
export async function delegateProjectRoot(projectId: string): Promise<string | null> {
  const [{ approvalKeyFor }, { getAllProjects }] = await Promise.all([
    import("@/lib/project-environment/workspace-config-trust"),
    import("@/lib/db/projects"),
  ])
  try {
    const { useProjectStore } = await import("@/stores/project/project-store")
    const fromStore = useProjectStore.getState().projects.find((p) => p.id === projectId)
    if (fromStore) return approvalKeyFor(fromStore)
  } catch {
    // A headless brain never loads the project store; fall through to Dexie.
  }
  const rows = await getAllProjects().catch(() => [])
  const row = rows.find((project) => project.id === projectId)
  return row ? approvalKeyFor(row) : null
}

/** The strongest tier this device reports, or null. Never throws. */
export async function hostSandboxTier(): Promise<SandboxTier | null> {
  try {
    const { defaultAcceptanceSandboxHost, selectSandboxTier } =
      await import("../verify/code-acceptance-host")
    return selectSandboxTier(await defaultAcceptanceSandboxHost().availability())
  } catch {
    // A probe that cannot answer is not a tier. Delegate is excluded, which is
    // the safe direction: nothing runs unconfined because a check failed.
    return null
  }
}

/**
 * Both delegate capabilities for one project. A request that names no project
 * cannot have them, and says so with `no_project` rather than probing.
 */
export async function delegateCapabilitiesFor(
  projectId: string | null | undefined,
  deps: DelegateCapabilityDeps = {}
): Promise<DelegateCapabilities> {
  if (!projectId) return DELEGATE_UNAVAILABLE
  const profilesOf =
    deps.acceptanceProfiles ??
    (async (id: string) => {
      const { acceptanceProfileAvailable } = await import("../verify/acceptance-profiles")
      const availability = await acceptanceProfileAvailable(id)
      return {
        available: availability.available,
        approvedProfileIds: availability.approvedProfileIds,
        reason: availability.reason,
      }
    })
  const [tier, profiles] = await Promise.all([
    (deps.sandboxTier ?? hostSandboxTier)(),
    profilesOf(projectId).catch(() => ({
      available: false,
      approvedProfileIds: [] as string[],
      reason: "fault",
    })),
  ])
  const reason =
    tier === null ? "no_sandbox_tier" : profiles.available ? null : (profiles.reason ?? "absent")
  return {
    sandboxTier: tier,
    acceptanceProfileAvailable: profiles.available,
    approvedProfileIds: profiles.approvedProfileIds,
    reason,
  }
}
