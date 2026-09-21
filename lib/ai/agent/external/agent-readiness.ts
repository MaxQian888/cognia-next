/**
 * Agent readiness pipeline — the "why can't this agent run" model.
 *
 * Four steps, projected entirely from data the store already holds:
 *
 *   configured  the saved config exists (always done once listed)
 *   runnable    passes the execution gate — enabled, supported protocol,
 *               reachable transport, ecosystem prerequisites satisfied
 *   connected   live connection status from the runtime manager
 *   routed      at least one enabled delegation rule targets this agent
 *
 * `nextAction` is the single most useful thing a row can offer: enabling a
 * deliberately-disabled agent, inspecting a block, retrying an error,
 * connecting, or finishing setup with a routing rule. It is deliberately
 * `null` while connecting — there is nothing to do but wait.
 */

import type {
  ExternalAgentConfig,
  ExternalAgentConnectionStatus,
  ExternalAgentValiditySnapshot,
} from "@/types/agent/external-agent"

import { getExternalAgentExecutionBlock, type ExternalAgentRuntimeReach } from "./config-normalizer"

/** Compact per-agent state used for rail rows, pills, and the board. */
export type AgentReadinessState =
  "disabled" | "blocked" | "error" | "connecting" | "connected" | "off"

export type AgentReadinessStepId = "configured" | "runnable" | "connected" | "routed"

export type AgentReadinessStepState = "done" | "current" | "failed" | "todo" | "off"

export interface AgentReadinessStep {
  id: AgentReadinessStepId
  state: AgentReadinessStepState
}

/**
 * What the one action button on a row/header should do. Kept as ids — lib/
 * stays locale-free, the renderer maps these to labels and handlers.
 */
export type AgentReadinessAction = "enable" | "inspect" | "retry" | "connect" | "add-rule"

export interface AgentReadiness {
  state: AgentReadinessState
  /**
   * Why the agent cannot run, when `state === "blocked"`. Prefers the runtime
   * verdict (`agentValidity`) over the static gate, matching the precedence
   * the old detail pane used.
   */
  blockReason: string | null
  /**
   * The block may resolve itself — a Host still handshaking, a plugin adapter
   * still registering. Rendered as "checking" rather than a settled failure.
   */
  blockTransient: boolean
  steps: AgentReadinessStep[]
  nextAction: AgentReadinessAction | null
}

export function computeAgentReadiness(input: {
  agent: ExternalAgentConfig
  connectionStatus: ExternalAgentConnectionStatus | undefined
  delegatedRuleCount: number
  validity?: ExternalAgentValiditySnapshot
  /**
   * Caller's resolved process-plane answer. React callers should pass the
   * `useExternalAgentProcessPlane()` result so a Host finishing its handshake
   * recomputes the "runnable" step; omitted, the gate asks the plane itself
   * (correct at call time, not reactive).
   */
  reach?: ExternalAgentRuntimeReach
}): AgentReadiness {
  const { agent, delegatedRuleCount, validity } = input
  const status = input.connectionStatus ?? "disconnected"

  const disabled = agent.enabled === false
  const assessment = disabled ? null : getExternalAgentExecutionBlock(agent, input.reach)
  const runtimeBlock = validity?.executable === false ? (validity.blockingReason ?? null) : null
  const blockReason = disabled ? null : (runtimeBlock ?? assessment?.reason ?? null)
  const blocked = blockReason !== null
  const blockTransient = blocked && validity?.executable !== false && assessment?.transient === true

  const state: AgentReadinessState = disabled
    ? "disabled"
    : blocked
      ? "blocked"
      : status === "error"
        ? "error"
        : status === "connecting" || status === "reconnecting"
          ? "connecting"
          : status === "connected"
            ? "connected"
            : "off"

  const runnableState: AgentReadinessStepState = disabled
    ? "off"
    : blocked
      ? blockTransient
        ? "current"
        : "failed"
      : "done"

  const connectedState: AgentReadinessStepState = disabled
    ? "off"
    : blocked
      ? "todo"
      : status === "connected"
        ? "done"
        : status === "connecting" || status === "reconnecting"
          ? "current"
          : status === "error"
            ? "failed"
            : "todo"

  const steps: AgentReadinessStep[] = [
    { id: "configured", state: "done" },
    { id: "runnable", state: runnableState },
    { id: "connected", state: connectedState },
    // Routing is configured state, not runtime state: a disconnected agent
    // with rules still counts as routed.
    { id: "routed", state: delegatedRuleCount > 0 ? "done" : "todo" },
  ]

  const nextAction: AgentReadinessAction | null =
    state === "disabled"
      ? "enable"
      : state === "blocked"
        ? "inspect"
        : state === "error"
          ? "retry"
          : state === "connecting"
            ? null
            : state === "off"
              ? "connect"
              : delegatedRuleCount === 0
                ? "add-rule"
                : null

  return { state, blockReason, blockTransient, steps, nextAction }
}
