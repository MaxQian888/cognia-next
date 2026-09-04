/**
 * A scripted conversation, and the fake agent session that plays it.
 *
 * Test-only. The production `App` is mounted unchanged and driven through a
 * real PTY (see `conversation-driver`). The only thing swapped out is the
 * agent behind `CreateSession`, so the transport, the reducer, the layout and
 * the key handling under test are the shipped ones.
 *
 * The scenario is data, and it crosses a process boundary as JSON, because the
 * fixture runs as its own bundled program. Keeping it declarative is what lets
 * one driver replay a permission prompt, a tool failure and a mid-turn abort
 * without a bespoke fixture for each.
 */
import type { CapturePermissionDecision, PermissionRequestEvent } from "@cognia/agent-config-types"
import type { CreateSession } from "../hooks/useAgentSession"

/** One thing the scripted agent does during a turn, in order. */
export type ScenarioStep =
  /** Stream assistant text. */
  | { kind: "text"; delta: string }
  /** Stream reasoning. */
  | { kind: "thinking"; delta: string }
  /** Announce a tool call. */
  | { kind: "tool-call"; id: string; toolName: string; input?: Record<string, unknown> }
  /** Complete a previously announced call. */
  | {
      kind: "tool-result"
      id: string
      toolName: string
      result: unknown
      isError?: boolean
      input?: Record<string, unknown>
    }
  /**
   * Ask the user to approve a tool, through the same gate the real agent uses.
   * The decision is recorded so a test can assert what the agent was told,
   * which is the half of an approval that the screen cannot show.
   */
  | {
      kind: "ask-permission"
      toolName: string
      input?: Record<string, unknown>
      displayName?: string
      description?: string
    }
  /** Report token usage mid-turn. */
  | { kind: "usage"; inputTokens: number; outputTokens: number }
  /** Pause, so a test can act while the turn is still open. */
  | { kind: "delay"; ms: number }
  /**
   * Pause until the turn is aborted, and only then.
   *
   * A bounded delay is a race with the machine: on a loaded host the driver's
   * own keystrokes can take longer to land than the pause, and the turn it
   * meant to interrupt has already finished. A test about stopping a running
   * turn needs the turn to still be running, whatever else is going on.
   */
  | { kind: "hold" }
  /** Fail the turn. `recoverable` failures leave the session usable. */
  | { kind: "fail"; message: string; recoverable?: boolean }

export interface ScenarioTurn {
  steps?: ScenarioStep[]
  /** The turn's final reply. Defaults to the concatenated `text` steps. */
  reply?: string
}

export interface ConversationScenario {
  /** Played in order, one per user message. */
  turns?: ScenarioTurn[]
  /** Played for any turn past the end of `turns`. */
  fallback?: ScenarioTurn
}

/** What the scripted agent observed, for assertions the screen cannot make. */
export interface ScenarioRecord {
  prompts: string[]
  decisions: Array<{ toolName: string; decision: CapturePermissionDecision }>
  aborted: number
}

export function emptyScenarioRecord(): ScenarioRecord {
  return { prompts: [], decisions: [], aborted: 0 }
}

const DEFAULT_FALLBACK: ScenarioTurn = { steps: [{ kind: "text", delta: "deterministic reply" }] }

/** The reply a turn resolves with: an explicit one, else everything it streamed. */
export function scenarioReplyText(turn: ScenarioTurn): string {
  if (turn.reply !== undefined) return turn.reply
  return (turn.steps ?? []).flatMap((step) => (step.kind === "text" ? [step.delta] : [])).join("")
}

function permissionRequest(
  step: Extract<ScenarioStep, { kind: "ask-permission" }>,
  sessionId: string,
  seq: number
): PermissionRequestEvent {
  return {
    type: "permission_request",
    sessionId,
    requestId: `scenario-${seq}`,
    toolUseID: `scenario-tool-${seq}`,
    toolName: step.toolName,
    input: step.input ?? {},
    ...(step.displayName ? { displayName: step.displayName } : {}),
    ...(step.description ? { description: step.description } : {}),
  }
}

/**
 * An error the scenario raised on purpose.
 *
 * Named so the surrounding code can tell a scripted failure from a defect in
 * the harness. A scripted failure has to reach the app the way a real one
 * does, which means throwing out of `send`.
 */
export class ScenarioFailure extends Error {
  constructor(
    message: string,
    readonly recoverable: boolean
  ) {
    super(message)
    this.name = "ScenarioFailure"
  }
}

/**
 * Build the `CreateSession` the fixture mounts.
 *
 * `record` is filled in as the scenario plays. The fixture prints it on exit,
 * which is how the driver learns what the agent was told.
 */
export function scenarioCreateSession(
  scenario: ConversationScenario,
  record: ScenarioRecord,
  sessionId = "pty-fixture"
): CreateSession {
  let turnIndex = 0
  let seq = 0
  return () => ({
    sessionId,
    async send(prompt, options) {
      record.prompts.push(prompt)
      const turn = scenario.turns?.[turnIndex] ?? scenario.fallback ?? DEFAULT_FALLBACK
      turnIndex += 1
      for (const step of turn.steps ?? []) {
        if (options.signal?.aborted) {
          record.aborted += 1
          throw new ScenarioFailure("aborted", true)
        }
        seq += 1
        switch (step.kind) {
          case "text":
            options.onEvent?.({ type: "text-delta", delta: step.delta })
            break
          case "thinking":
            options.onEvent?.({ type: "thinking-delta", delta: step.delta })
            break
          case "tool-call":
            options.onEvent?.({
              type: "tool-call",
              id: step.id,
              toolName: step.toolName,
              input: step.input ?? {},
            })
            break
          case "tool-result":
            options.onEvent?.({
              type: "tool-result",
              id: step.id,
              toolName: step.toolName,
              result: step.result,
              ...(step.isError ? { isError: true } : {}),
              ...(step.input ? { input: step.input } : {}),
            })
            break
          case "ask-permission": {
            const decision = await options.gate(permissionRequest(step, sessionId, seq))
            record.decisions.push({ toolName: step.toolName, decision })
            break
          }
          case "usage":
            options.onEvent?.({
              type: "usage",
              usage: { inputTokens: step.inputTokens, outputTokens: step.outputTokens },
            })
            break
          case "hold":
            await new Promise<void>((_resolve, reject) => {
              const signal = options.signal
              const onAbort = () => {
                record.aborted += 1
                reject(new ScenarioFailure("aborted", true))
              }
              if (signal?.aborted) onAbort()
              else signal?.addEventListener("abort", onAbort, { once: true })
            })
            break
          case "delay":
            // Abort-aware, the way a real in-flight provider call is. A delay
            // that ran to completion regardless made a cancelled turn look like
            // one that simply finished, so the record could not tell the two
            // apart and a stop that never reached the agent would have passed.
            await new Promise<void>((resolve, reject) => {
              const signal = options.signal
              const timer = setTimeout(() => {
                signal?.removeEventListener("abort", onAbort)
                resolve()
              }, step.ms)
              const onAbort = () => {
                clearTimeout(timer)
                record.aborted += 1
                reject(new ScenarioFailure("aborted", true))
              }
              if (signal?.aborted) onAbort()
              else signal?.addEventListener("abort", onAbort, { once: true })
            })
            break
          case "fail":
            throw new ScenarioFailure(step.message, step.recoverable ?? false)
        }
      }
      return {
        text: scenarioReplyText(turn),
        messageId: `pty-message-${turnIndex}`,
        a2uiSurfaces: {},
        a2uiSurfaceOrder: [],
      }
    },
    async close() {},
  })
}
