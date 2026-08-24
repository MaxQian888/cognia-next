/**
 * Reads the active workspace's capability overlay for the definition tables.
 *
 * `lib/db/skills.ts` and `lib/db/mcp-servers.ts` answer "what is enabled" for
 * roughly twenty call sites — send options, the scheduler, slash commands, the
 * apps runtime. Rather than teach each of them about workspaces, the overlay is
 * resolved here and applied inside those two readers, which is the same shape
 * Dexie row scoping already has: `resolveScopeProjectId` decides whose data
 * this is, and the caller passes an explicit id only when it is acting for a
 * workspace other than the one on screen.
 *
 * That explicit path is not decoration. A scheduled run belongs to the
 * workspace that scheduled it, which is very often not the active one; reading
 * the UI pointer there would give a cron job whichever capability set the user
 * happened to be looking at.
 */

import type { WorkspaceCapabilityOverlay } from "@/lib/workspace/capability-overlay"
import { EMPTY_CAPABILITY_OVERLAY } from "@/lib/workspace/capability-overlay"

import { resolveScopeProjectId } from "./project-scope"
import { getDb } from "./schema"

/** Where a read should take its capability set from. */
export interface WorkspaceCapabilityScope {
  /**
   * Resolve against this workspace instead of the active one. Pass it whenever
   * the caller is acting for a workspace the user is not looking at.
   */
  projectId?: string | null
  /**
   * Ignore the overlay entirely and answer with the global flags. For surfaces
   * that are honestly machine-wide — the settings library, diagnostics — where
   * hiding rows would misreport what is installed.
   */
  workspaceScoped?: boolean
}

/**
 * The overlay for one workspace, or the empty overlay when there is none.
 *
 * Never throws: a definition read is on the send path, and a failure to load a
 * preference must degrade to "no opinion" rather than take the turn down.
 */
export async function loadWorkspaceCapabilityOverlay(
  scope?: WorkspaceCapabilityScope
): Promise<WorkspaceCapabilityOverlay> {
  if (scope?.workspaceScoped === false) return EMPTY_CAPABILITY_OVERLAY
  try {
    const projectId = await resolveScopeProjectId(scope?.projectId ?? null)
    const project = await getDb().projects.get(projectId)
    return project?.capabilityOverlay ?? EMPTY_CAPABILITY_OVERLAY
  } catch {
    return EMPTY_CAPABILITY_OVERLAY
  }
}
