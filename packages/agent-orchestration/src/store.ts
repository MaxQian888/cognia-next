/**
 * The persistence port of a durable Agent Team run (ADR-0217).
 *
 * The coordinator, the dispatch path and recovery reach run state only
 * through this interface. The desktop app implements it over Dexie
 * (`lib/db/agent-team-runtime.ts`); {@link createMemoryTeamRunStore} is the
 * reference implementation; both must pass `TEAM_RUN_STORE_CONTRACT`. Every
 * implementation applies the rules in `./rules`, so compare-and-set, the
 * dispatch lease and the monotonic trajectory mean the same thing everywhere.
 */

import type {
  AgentTeamCheckpoint,
  AgentTeamChildRun,
  AgentTeamContentObject,
  AgentTeamRunRecord,
  AgentTeamSteeringReceipt,
  AgentTeamSteeringStatus,
  AgentTeamTrajectoryEvent,
} from "./records"
import type {
  AppendTrajectoryInput,
  ClaimDispatchLeaseInput,
  ControlState,
  MarkCheckpointInput,
} from "./rules"

export type RunPatch<TConstraints = unknown> = Partial<
  Omit<AgentTeamRunRecord<TConstraints>, "id" | "teamId" | "createdAt">
>
export type ChildPatch = Partial<Omit<AgentTeamChildRun, "id" | "runId" | "teamId" | "createdAt">>

/** Bytes to store content-addressed alongside a trajectory event. */
export interface TrajectoryContent {
  data: string | Uint8Array
  mimeType: string
}

/** `TConstraints`: the host's launch-authority payload stored on each run. */
export interface TeamRunStore<TConstraints = unknown> {
  /**
   * Run `operation` as one atomic unit through `tx`: every call it makes on
   * `tx` commits together or not at all, and no other writer interleaves with
   * it. Calls on the store itself (rather than `tx`) from inside the operation
   * are outside the unit; implementations may make them wait for it.
   */
  atomically<T>(operation: (tx: TeamRunStore<TConstraints>) => Promise<T>): Promise<T>

  createRun(run: AgentTeamRunRecord<TConstraints>): Promise<void>
  getRun(id: string): Promise<AgentTeamRunRecord<TConstraints> | undefined>
  updateRun(id: string, patch: RunPatch<TConstraints>): Promise<boolean>
  /** Update only while the run's control state is still `expected`. */
  updateRunIfCurrent(
    id: string,
    expected: ControlState,
    patch: RunPatch<TConstraints>
  ): Promise<boolean>
  /** Newest first; optionally one team's runs. */
  listRuns(teamId?: string): Promise<AgentTeamRunRecord<TConstraints>[]>
  /** Interrupted runs in recovery order (`selectRecoveryCandidates`). */
  listRecoveryCandidates(): Promise<AgentTeamRunRecord<TConstraints>[]>

  createChild(child: AgentTeamChildRun): Promise<void>
  getChild(id: string): Promise<AgentTeamChildRun | undefined>
  /** Oldest first. */
  listChildren(runId: string): Promise<AgentTeamChildRun[]>
  findLatestChild(
    runId: string,
    taskId: string,
    teammateId: string
  ): Promise<AgentTeamChildRun | undefined>
  updateChild(id: string, patch: ChildPatch): Promise<boolean>
  /** Update only while the child's control state is still `expected`. */
  updateChildIfCurrent(id: string, expected: ControlState, patch: ChildPatch): Promise<boolean>

  /** Claim the child's dispatch lease; `undefined` while another lease holds it. */
  claimDispatchLease(input: ClaimDispatchLeaseInput): Promise<AgentTeamChildRun | undefined>
  renewDispatchLease(
    childRunId: string,
    expectedLeaseId: string,
    now: number,
    ttlMs?: number
  ): Promise<boolean>
  settleDispatchLease(childRunId: string, expectedLeaseId: string, now: number): Promise<boolean>
  /**
   * Advance the child's remote event cursor from `expectedPreviousEventId` to
   * `eventId`, recording the event in the trajectory when `envelope` is given.
   * False (nothing written) when the cursor moved: a duplicate or out-of-order
   * replay.
   */
  advanceRemoteEvent(
    childRunId: string,
    expectedPreviousEventId: string | undefined,
    eventId: string,
    now: number,
    envelope?: { runId: string; event: Record<string, unknown> }
  ): Promise<boolean>

  appendTrajectory(
    input: AppendTrajectoryInput,
    content?: TrajectoryContent
  ): Promise<AgentTeamTrajectoryEvent>
  /** Events with `sequence > afterSequence`, in sequence order. */
  listTrajectory(runId: string, afterSequence?: number): Promise<AgentTeamTrajectoryEvent[]>

  markCheckpoint(input: MarkCheckpointInput): Promise<AgentTeamCheckpoint>
  getLatestCheckpoint(childRunId: string): Promise<AgentTeamCheckpoint | undefined>

  createSteeringReceipt(receipt: AgentTeamSteeringReceipt): Promise<AgentTeamSteeringReceipt>
  updateSteeringReceipt(
    receiptId: string,
    status: AgentTeamSteeringStatus,
    at: number,
    reason?: string
  ): Promise<boolean>
  listPendingSteering(childRunId: string): Promise<AgentTeamSteeringReceipt[]>
  listSteeringReceipts(runId: string): Promise<AgentTeamSteeringReceipt[]>

  getContent(hash: string): Promise<AgentTeamContentObject | undefined>
}
