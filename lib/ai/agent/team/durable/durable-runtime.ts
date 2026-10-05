/**
 * The app's binding of the durable Agent Team coordinator (ADR-0217).
 *
 * The coordinator itself lives in `@cognia/agent-orchestration/coordinator`.
 * This module supplies the app's ports: run state in Dexie, the execution-run
 * journal, `@cognia/redact`, the app's path semantics and the managed fleet
 * session projection. It also maps an `AgentTeam` onto the coordinator's
 * team spec and holds the shared coordinator every app caller uses.
 */

import { hasNoLeakingPii, redactText } from "@cognia/redact"
import {
  createDurableTeamCoordinator as createCoordinator,
  isStoredChildReplaySafe,
  type DurableTeamCoordinator as Coordinator,
  type DurableTeamSpec,
  type TeamPathPolicy,
  type TeamRemoteSessions,
  type TeamRunJournal,
} from "@cognia/agent-orchestration/coordinator"
import type { TeamRunStore } from "@cognia/agent-orchestration/store"
import { dexieTeamRunStore } from "@/lib/db/agent-team-runtime"
import { createExecutionRun, getExecutionRun, runEventJournal } from "@/lib/db/execution-runs"
import { agentTeamExecutionRunId } from "@/lib/execution/agent-team-bridge"
import { isPathWithinRoot, normalizeFsPath } from "@/lib/files/permissions"
import type { AgentTeam } from "@/types/agent/agent-team"
import type {
  AgentTeamCheckpoint,
  AgentTeamExecutionConstraints,
  AgentTeamTrajectoryEvent,
} from "@/types/agent/agent-team-runtime"

export type {
  DurableChildControl,
  RecoveryOutcome,
  RegisterDurableChildInput,
  WorkspaceLeaseRequest,
} from "@cognia/agent-orchestration/coordinator"

/**
 * The execution-run journal as the coordinator's run journal. The row is
 * addressed the way `agent-team-bridge` addresses it, never by the bare run
 * id: both this path and `startSquadRun` create a row for the same run, and
 * the bridge's contract is that the ids converge because both derive from
 * `agentTeamExecutionRunId`, so whichever path runs first wins and the second
 * is a no-op. Keying this one on the bare id made `team:<runId>` and
 * `team:<teamId>` two journal sources, so the cockpit listed the same run
 * twice, the second copy with no session, its coordination tab "unavailable".
 */
export const executionRunTeamJournal: TeamRunJournal = {
  async runPrepared({ runId, projectId, title, at }) {
    const executionRunId = agentTeamExecutionRunId(runId)
    const executionRun = await getExecutionRun(executionRunId)
    if (!executionRun) {
      await createExecutionRun({
        id: executionRunId,
        kind: "team",
        sourceId: runId,
        ...(projectId ? { projectId } : {}),
        title,
        status: "queued",
        currentRevision: 0,
        startedAt: at,
        updatedAt: at,
      })
      await runEventJournal.append(executionRunId, {
        id: `execution-event:${runId}:started`,
        ts: at,
        type: "run.started",
        visibility: "summary",
        payload: { summary: "Agent team run started" },
      })
    } else if (["waiting", "paused", "recovery_required"].includes(executionRun.status)) {
      await runEventJournal.append(executionRunId, {
        id: `execution-event:${runId}:resumed:${at}`,
        ts: at,
        type: "run.resumed",
        visibility: "summary",
        payload: { summary: "Agent team run resumed" },
      })
    }
  },
}

/** Redacted text, or `undefined` when it still leaks after redaction. */
export function redactTeamTextForPersistence(text: string): string | undefined {
  const redacted = redactText(text).redacted
  return hasNoLeakingPii(redacted) ? redacted : undefined
}

export const appTeamPathPolicy: TeamPathPolicy = {
  normalize: normalizeFsPath,
  isWithinRoot: isPathWithinRoot,
}

export const fleetTeamRemoteSessions: TeamRemoteSessions = {
  async release(remoteSessionId) {
    const { removeManagedFleetSession } = await import("@/lib/fleet/managed-session-projection")
    // The child is already terminated in the store; a projection that could
    // not be removed now is not a reason to report the termination as failed.
    await removeManagedFleetSession(remoteSessionId).catch(() => false)
  },
}

/** The coordinator's view of an app team. */
export function durableTeamSpec(team: AgentTeam): DurableTeamSpec {
  const { config } = team
  return {
    id: team.id,
    leadId: team.leadId,
    ...(team.projectId ? { projectId: team.projectId } : {}),
    objective: team.task,
    ...(config.repositories ? { repositories: config.repositories } : {}),
    ...(config.workingDir ? { workingDir: config.workingDir } : {}),
    ...(config.writeMode ? { writeMode: config.writeMode } : {}),
    ...(config.resourcePolicy ? { resourcePolicy: config.resourcePolicy } : {}),
    ...(config.maxConcurrentTeammates !== undefined
      ? { maxConcurrentTeammates: config.maxConcurrentTeammates }
      : {}),
    ...(config.environmentRef ? { environmentVersionId: config.environmentRef.versionId } : {}),
    ...(config.userConstraints ? { userConstraints: config.userConstraints } : {}),
  }
}

export interface DurableTeamCoordinatorOptions {
  /** Where run state lives; the app's Dexie store by default. */
  store?: TeamRunStore<AgentTeamExecutionConstraints>
  now?: () => number
  globalConcurrency?: number
  agingIntervalMs?: number
}

export function createDurableTeamCoordinator(options: DurableTeamCoordinatorOptions = {}) {
  const coordinator = createCoordinator<AgentTeamExecutionConstraints>({
    store: options.store ?? dexieTeamRunStore,
    journal: executionRunTeamJournal,
    redactForPersistence: redactTeamTextForPersistence,
    paths: appTeamPathPolicy,
    remoteSessions: fleetTeamRemoteSessions,
    ...(options.now ? { now: options.now } : {}),
    ...(options.globalConcurrency !== undefined
      ? { globalConcurrency: options.globalConcurrency }
      : {}),
    ...(options.agingIntervalMs !== undefined ? { agingIntervalMs: options.agingIntervalMs } : {}),
  })
  return {
    ...coordinator,
    /** Prepare a durable run of an app team (see `durableTeamSpec`). */
    prepareRun: (team: AgentTeam, runId?: string) =>
      coordinator.prepareRun(durableTeamSpec(team), runId),
  }
}

export type DurableTeamCoordinator = Omit<
  Coordinator<AgentTeamExecutionConstraints>,
  "prepareRun"
> & {
  prepareRun(team: AgentTeam, runId?: string): Promise<string>
}

let sharedCoordinator: DurableTeamCoordinator | undefined

export function getDurableTeamCoordinator(): DurableTeamCoordinator {
  sharedCoordinator ??= createDurableTeamCoordinator()
  return sharedCoordinator
}

export function __resetDurableTeamCoordinatorForTesting(): void {
  sharedCoordinator = undefined
}

/**
 * Whether a child may be replayed from its checkpoint, reading from `store`
 * (the shared coordinator's store by default, so every app caller sees the
 * run state the coordinator writes).
 */
export function isDurableChildReplaySafe(
  childRunId: string,
  checkpoint?: AgentTeamCheckpoint,
  trajectory?: readonly AgentTeamTrajectoryEvent[],
  store: TeamRunStore<AgentTeamExecutionConstraints> = getDurableTeamCoordinator().store
): Promise<boolean> {
  return isStoredChildReplaySafe(store, childRunId, checkpoint, trajectory)
}
