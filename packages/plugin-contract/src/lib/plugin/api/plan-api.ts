/**
 * The plugin contract's share of `lib/plugin/api/plan-api.ts`, which re-exports these.
 */
import type {
  AgentPlan,
  CreatePlanInput,
  PlanEvent,
  PlanRefinementType,
  PlanStatus,
  PlanStepStatus,
  UpdatePlanInput,
} from "../../../types/agent/plan"

/** Plan authoring + driving API exposed to plugins. */
export interface PluginPlanAPI {
  // --------------------------------------------------------------- reads
  /** Fetch a plan by id, or `null` if it doesn't exist. */
  get(planId: string): Promise<AgentPlan | null>
  /** All plans bound to a session (newest first). */
  listBySession(sessionId: string): Promise<AgentPlan[]>
  /** Every plan across all sessions (bounded by `limit`, default 200). */
  listAll(limit?: number): Promise<AgentPlan[]>
  /** The session's open plan (draft / awaiting approval / approved / live). */
  getOpenForSession(sessionId: string): Promise<AgentPlan | null>
  /** The session's executing plan, if one is running. */
  getExecutingForSession(sessionId: string): Promise<AgentPlan | null>
  /** The plan's lifecycle timeline, newest-last. */
  getEvents(planId: string, limit?: number): Promise<PlanEvent[]>

  // ----------------------------------------------------------- mutations
  /** Create a plan. Replaces the session's existing open plan, as every producer does. */
  create(input: CreatePlanInput): Promise<AgentPlan>
  /** Patch a not-yet-executing plan (title / description / steps / config). */
  updateDraft(planId: string, patch: UpdatePlanInput): Promise<AgentPlan | null>
  /** Approve a plan for execution. */
  approve(planId: string): Promise<AgentPlan | null>
  /**
   * Reject a plan that has not started (draft / awaiting approval / approved)
   * → terminal `rejected` status, with a `rejected` trail event carrying the
   * optional reason. Returns the unchanged row for a plan already executing or
   * paused — stop those with {@link cancel}.
   */
  reject(planId: string, feedback?: string): Promise<AgentPlan | null>
  /**
   * Start an approved plan. In-session plans return the turn the host should
   * send; orchestrated plans are started with {@link run}.
   */
  start(
    planId: string
  ): Promise<{ strategy: "in_session" | "orchestrated"; status: PlanStatus } | null>
  /** Execute an approved plan through the orchestrated path (headless). */
  run(planId: string): Promise<{ status: PlanStatus; output?: unknown } | null>
  /** Pause a running plan. */
  pause(planId: string): Promise<AgentPlan | null>
  /**
   * Resume a paused plan. An in-session plan restarts its interrupted step,
   * which only a chat surface can send; unsent, it halts `not_started` for the
   * user to retry from the conversation's plan card.
   */
  resume(planId: string): Promise<AgentPlan | null>
  /** Cancel any non-terminal plan. */
  cancel(planId: string): Promise<AgentPlan | null>
  /** Write one step's status (+ optional result summary). */
  setStepStatus(
    planId: string,
    stepId: string,
    status: PlanStepStatus,
    result?: string
  ): Promise<AgentPlan | null>
  /** Replan through the planner model (optimize / simplify / expand / reorder / repair). */
  refine(planId: string, type: PlanRefinementType, instructions?: string): Promise<AgentPlan | null>
  /** Delete a plan and its events. */
  delete(planId: string): Promise<void>
}
