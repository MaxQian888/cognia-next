/**
 * The workspace a scheduled run resolves against: what `resolveSendOptions`
 * sees as the turn's `activeProject`, and the Workspace Trust verdict over it.
 *
 * That is the one named by the run's owning `projectId`, never the one active
 * in the UI (ADR-0144). A schedule fires for the workspace that owns its
 * conversation, which is rarely the one on screen when the timer fires, and
 * often nothing is on screen at all. Goes through `resolveSessionWorkspace`,
 * the resolver interactive chat uses, with no active-workspace fallback. A
 * workspace that no longer exists resolves to `null`, as it does for an
 * interactive turn.
 *
 * Read from Dexie rather than `useProjectStore`: the headless brain and a
 * timer firing before the renderer hydrates have no store to read.
 *
 * Own module because both the chat-style executors and the headless goal
 * runner resolve it, and the executor index already imports the goal path.
 */

import type { AppSettings } from "@cognia/agent-config-types"
import type { Project } from "@/types"
import { getAllProjects } from "@/lib/db/projects"
import { allRootPaths } from "@/lib/workspace/roots"
import { resolveSessionWorkspace } from "@/lib/workspace/session-workspace"
import {
  resolveWorkspaceTrustForSend,
  type WorkspaceTrustForSend,
} from "@/lib/workspace/trust-gate"
import { loggers } from "@cognia/logging"
import { hostEnforcesWorkspaceTrust } from "../host-support"

const log = loggers.scheduler

export interface OwningWorkspace {
  /** The run's workspace, or `null` when it names none or it no longer exists. */
  project: Project | null
  /**
   * The run names a workspace, but the workspace list could not be read. The
   * roots it would work in are unknown, so Workspace Trust treats it as
   * unverified rather than as "no workspace" (which is ungated).
   */
  readFailed: boolean
}

export async function loadOwningWorkspace(
  projectId: string | null | undefined,
  logContext: Record<string, string>
): Promise<OwningWorkspace> {
  if (!projectId) return { project: null, readFailed: false }
  try {
    return {
      project: resolveSessionWorkspace({ projectId }, await getAllProjects()),
      readFailed: false,
    }
  } catch (err) {
    log.warn("Scheduler: loading the owning workspace failed; running in Restricted Mode", {
      ...logContext,
      projectId,
      err: String(err),
    })
    return { project: null, readFailed: true }
  }
}

/** Workspace Trust as a scheduled run applies and reports it. */
export interface ScheduledWorkspaceTrust extends WorkspaceTrustForSend {
  /**
   * The workspace or its trust ledger could not be read. The run is restricted
   * without a verdict and every known root is reported as untrusted: a trust
   * question nobody could answer is not an answer of "yes".
   */
  unverified?: true
}

/**
 * Workspace Trust for a scheduled run, decided by the gate interactive chat
 * uses (`resolveWorkspaceTrustForSend`) over the run's owning workspace. An
 * untrusted workspace runs in Restricted Mode: `resolveSendOptions` denies
 * every disk/host-mutating tool, and no trust proof is sent, so the sidecar
 * loads no native SDK skills/plugins from it.
 *
 * The host input is capability-based (`hostEnforcesWorkspaceTrust`), not
 * `isTauri()`, because the headless brain holds real checkouts and is gated the
 * same as the desktop. Fails closed when the workspace or the ledger cannot be
 * read.
 */
export async function resolveScheduledWorkspaceTrust(
  owning: OwningWorkspace,
  appSettings: AppSettings | null,
  logContext: Record<string, string>
): Promise<ScheduledWorkspaceTrust> {
  const opts = {
    enabled: appSettings?.workspaceTrust?.enabled !== false,
    onWeb: !hostEnforcesWorkspaceTrust(),
  }
  if (owning.readFailed && opts.enabled && !opts.onWeb) {
    return { restricted: true, trustedRoots: [], untrustedRoots: [], unverified: true }
  }
  try {
    return await resolveWorkspaceTrustForSend(owning.project, opts)
  } catch (err) {
    log.warn("Scheduler: Workspace Trust check failed; running in Restricted Mode", {
      ...logContext,
      err: String(err),
    })
    return {
      restricted: true,
      trustedRoots: [],
      untrustedRoots: owning.project ? allRootPaths(owning.project) : [],
      unverified: true,
    }
  }
}
