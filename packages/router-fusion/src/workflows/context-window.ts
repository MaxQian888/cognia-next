/**
 * Context budgets for multi-role work (DESIGN §9.2, §12.3; PAN-08, F06).
 *
 * Two promises:
 *
 * - **A panel checks that it fits before it starts.** The worst case of every
 *   candidate's answer must fit into the judge's window, and the judge's report
 *   plus the approved material must fit into the synthesizer's — and into the
 *   judge's again for the final check. When it does not, the candidates' output
 *   bound is lowered to what fits (down to a floor); below the floor the action
 *   is refused. A dispute is never silently truncated to make room.
 * - **A transcript is compacted, not cut.** At 75 % of a role's window, and only
 *   with no tool call pending, the transcript is summarised by the compactor
 *   role into a new context epoch. The summary is billed like any call, and the
 *   hard constraints are re-injected by code from the task state, never left to
 *   the summary. No money for the summary is `CONTEXT_BUDGET_EXHAUSTED`.
 */

import type { Message } from "../contracts/schemas"
import { estimateTokens } from "../routing/features"
import {
  BudgetRefusedError,
  WorkflowError,
  performDurableCall,
  type DurableCallPorts,
} from "./durable-call"
import { roleMessages, untrustedBlock } from "./prompting"

export const COMPACTION_THRESHOLD = 0.75
/** Below this a candidate cannot give a complete answer, so the action is refused instead. */
export const MIN_MEMBER_OUTPUT_TOKENS = 512

export interface RoleWindow {
  contextLimit: number
  outputTokens: number
}

export interface PanelContextInput {
  /** The task contract and the common evidence, as every role receives them. */
  taskTokens: number
  members: number
  /** The output bound the action asks for per candidate. */
  memberOutputTokens: number
  judge: RoleWindow
  synthesizer: RoleWindow
  /** Output bound of the final verification call (made on the judge deployment). */
  finalCheckOutputTokens: number
  /** Room kept in the judge's window for one round of verification reports. */
  evidenceTokens: number
  /** System prompt and framing per call. */
  overheadTokens: number
  minMemberOutputTokens?: number
}

export type PanelContextPlan =
  | {
      ok: true
      memberOutputTokens: number
      /** The candidates' bound was lowered to fit; the run records it. */
      adjusted: boolean
      judgeInputTokens: number
      synthesizerInputTokens: number
      finalCheckInputTokens: number
    }
  | {
      ok: false
      code: "CONTEXT_PRECHECK_FAILED"
      /** Which window could not take even the floor. */
      window: "judge" | "synthesizer" | "final_check"
      needTokens: number
      limitTokens: number
    }

export function planPanelContext(input: PanelContextInput): PanelContextPlan {
  const floor = input.minMemberOutputTokens ?? MIN_MEMBER_OUTPUT_TOKENS
  const base = input.overheadTokens + input.taskTokens
  // Every window is `fixed + members × memberOut + output ≤ limit`; solve each for memberOut.
  const windows = [
    {
      name: "judge" as const,
      fixed: base + input.evidenceTokens,
      output: input.judge.outputTokens,
      limit: input.judge.contextLimit,
    },
    {
      name: "synthesizer" as const,
      fixed: base + input.judge.outputTokens,
      output: input.synthesizer.outputTokens,
      limit: input.synthesizer.contextLimit,
    },
    {
      name: "final_check" as const,
      fixed: base + input.synthesizer.outputTokens,
      output: input.finalCheckOutputTokens,
      limit: input.judge.contextLimit,
    },
  ]
  const members = Math.max(1, input.members)
  let memberOut = input.memberOutputTokens
  for (const window of windows) {
    const room = Math.floor((window.limit - window.fixed - window.output) / members)
    if (room < floor) {
      return {
        ok: false,
        code: "CONTEXT_PRECHECK_FAILED",
        window: window.name,
        needTokens: window.fixed + window.output + members * floor,
        limitTokens: window.limit,
      }
    }
    memberOut = Math.min(memberOut, room)
  }
  return {
    ok: true,
    memberOutputTokens: memberOut,
    adjusted: memberOut < input.memberOutputTokens,
    judgeInputTokens: windows[0].fixed + members * memberOut,
    synthesizerInputTokens: windows[1].fixed + members * memberOut,
    finalCheckInputTokens: windows[2].fixed + members * memberOut,
  }
}

export function transcriptTokens(messages: readonly Message[]): number {
  return messages.reduce((sum, message) => sum + estimateTokens(message.content) + 4, 0)
}

export type CompactionDecision =
  | { compact: false }
  | { compact: true }
  /** Over the threshold, but a tool call is still open: finish or cancel it first (CACHE-04). */
  | { compact: false; blocked: "PENDING_TOOL_CALLS" }

export function compactionDecision(input: {
  transcriptTokens: number
  contextLimit: number
  pendingToolCalls: number
}): CompactionDecision {
  if (input.transcriptTokens < input.contextLimit * COMPACTION_THRESHOLD) return { compact: false }
  if (input.pendingToolCalls > 0) return { compact: false, blocked: "PENDING_TOOL_CALLS" }
  return { compact: true }
}

/** The authoritative facts a handoff must carry, injected by code. */
export interface TaskState {
  goal: string
  constraints: string[]
  revision: string | null
}

export interface CompactionInput {
  runId: string
  /** The step whose transcript is compacted; the summary call is `<step>:compact:<epoch>`. */
  logicalStepId: string
  deploymentId: string
  reserveMicrousd: number
  transportAttempts: number
  deadlineAt: number
  signal: AbortSignal
  taskState: TaskState
  transcript: Message[]
  /** The epoch being closed. */
  epoch: number
  maxOutputTokens: number
}

export interface CompactionResult {
  messages: Message[]
  epoch: number
  handoff: string
}

/** Render the hard constraints the way every epoch receives them. */
export function authoritativeState(state: TaskState): string {
  return [
    "Authoritative task state (from the runtime, not from any summary):",
    `goal: ${state.goal}`,
    `revision: ${state.revision ?? "none"}`,
    "hard constraints:",
    ...(state.constraints.length > 0 ? state.constraints.map((c) => `- ${c}`) : ["- (none)"]),
  ].join("\n")
}

export async function compactTranscript(
  ports: DurableCallPorts,
  input: CompactionInput
): Promise<CompactionResult> {
  const pending = input.transcript.filter((message) => message.role !== "system")
  const system = input.transcript.find((message) => message.role === "system")
  let summary: string
  try {
    summary = (
      await performDurableCall(ports, {
        runId: input.runId,
        logicalStepId: `${input.logicalStepId}:compact:${input.epoch}`,
        role: "compactor",
        deploymentId: input.deploymentId,
        reserveMicrousd: input.reserveMicrousd,
        transportAttempts: input.transportAttempts,
        deadlineAt: input.deadlineAt,
        signal: input.signal,
        request: {
          messages: roleMessages("compactor", {
            contract: authoritativeState(input.taskState),
            material: [
              untrustedBlock(
                "the transcript to compact",
                pending.map((message) => `[${message.role}] ${message.content}`).join("\n\n")
              ),
            ],
          }),
          maxOutputTokens: input.maxOutputTokens,
          toolPolicyId: null,
        },
      })
    ).text
  } catch (error) {
    if (error instanceof BudgetRefusedError) {
      throw new WorkflowError(
        "CONTEXT_BUDGET_EXHAUSTED",
        "the transcript must be compacted and there is no budget left to do it",
        { refusal: error.code, epoch: input.epoch }
      )
    }
    throw error
  }
  await ports.events.emit({
    type: "phase.changed",
    payload: {
      phase: "context",
      step: "compacted",
      logical_step_id: input.logicalStepId,
      epoch: input.epoch + 1,
    },
  })
  return {
    epoch: input.epoch + 1,
    handoff: summary,
    messages: [
      ...(system ? [system] : []),
      {
        role: "user",
        content: [
          authoritativeState(input.taskState),
          untrustedBlock(`the handoff summary of context epoch ${input.epoch}`, summary),
        ].join("\n\n"),
      },
    ],
  }
}
