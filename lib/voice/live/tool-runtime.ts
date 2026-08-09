/**
 * Executes the tool calls a realtime model emits.
 *
 * The shape of a realtime tool round-trip:
 *
 *   function-call-arguments-done   (provider → us)
 *     → parse arguments
 *     → approval, if the policy does not already settle it
 *     → run the plugin tool
 *     → conversation-item-create { function-call-output }   (us → provider)
 *     → response-create, once every outstanding call has answered
 *
 * Three rules here are the difference between "works in a demo" and "works":
 *
 * - **Every path returns an output.** A denial, a parse failure and a crash all
 *   send a `function-call-output` carrying an error. A call that never gets an
 *   output leaves the model waiting forever, mid-conversation, with the
 *   microphone open.
 *
 * - **One `response-create` per batch.** A model can emit several function
 *   calls inside one response. Firing `response-create` per call makes
 *   providers reject the extras ("conversation already has an active
 *   response"), so the runtime counts calls in flight and asks for the
 *   continuation exactly once, when the last one lands.
 *
 * - **An integer epoch discards late work.** The user can end a session and
 *   start another immediately. A result carrying a `callId` the *new* session
 *   never issued makes most providers emit a fatal error frame and kill it, so
 *   results that arrive after {@link RealtimeToolRuntime.reset} are dropped.
 *
 * The PII gate is deliberately NOT re-applied around `handlePluginToolExec`:
 * every return path inside it already passes `assertSafePluginToolResult`, and
 * its production branch runs the plugin permission hierarchy and the consent
 * overlay. Adding another layer would prompt the user twice for one action.
 */

import type { Experimental_RealtimeModelV4ClientEvent as RealtimeClientEvent } from "@ai-sdk/provider"

import type { LiveVoiceAudioGate } from "./audio-gate"
import {
  cancelRealtimeToolApproval,
  realtimeToolWillPrompt,
  requestRealtimeToolApproval,
  type RealtimeToolPolicy,
} from "./approval"

/** A completed `function-call-arguments-done` event, narrowed to what we need. */
export interface RealtimeToolCall {
  callId: string
  name: string
  /** Complete JSON string of the arguments. */
  arguments: string
}

export interface RealtimeToolExecutionRequest {
  sessionId: string
  callId: string
  name: string
  args: Record<string, unknown>
  /** Cooperative cancellation; executors must check it before committing side effects. */
  signal: AbortSignal
}

export interface RealtimeToolExecutionResult {
  result?: unknown
  error?: string
}

export interface RealtimeToolRuntimeOptions {
  sessionId: string
  /** Read from `AppSettings.agentPermissions` when the session starts. */
  policy: RealtimeToolPolicy
  gate: LiveVoiceAudioGate
  send(event: RealtimeClientEvent): void
  /** Runs the tool. Must not throw — mirrors `handlePluginToolExec`. */
  execute(request: RealtimeToolExecutionRequest): Promise<RealtimeToolExecutionResult>
  onError?(error: Error): void
  onRecord?(record: RealtimeToolRecord): void
  now?(): number
}

export type RealtimeToolStatus = "completed" | "rejected" | "failed" | "cancelled"

export interface RealtimeToolRecord {
  callId: string
  name: string
  status: RealtimeToolStatus
  durationMs: number
}

/** Sent back when the user declines, so the model stops waiting on the call. */
export const REALTIME_TOOL_DENIED_ERROR = "denied by user"

export class RealtimeToolRuntime {
  private epoch = 0
  private inFlight = 0
  private readonly seenCallIds = new Set<string>()
  private readonly pendingCalls = new Map<
    string,
    { name: string; startedAt: number; abortController: AbortController }
  >()
  private readonly lifecycleRecords: RealtimeToolRecord[] = []

  constructor(private readonly options: RealtimeToolRuntimeOptions) {}

  /** Calls still awaiting approval or execution. Exposed for assertions. */
  get pending(): number {
    return this.inFlight
  }

  get records(): readonly RealtimeToolRecord[] {
    return this.lifecycleRecords
  }

  /**
   * Invalidate everything in flight, e.g. because the session ended. Results
   * that land afterwards are dropped rather than sent to whatever session has
   * taken this one's place.
   */
  reset(): void {
    this.epoch += 1
    const now = (this.options.now ?? Date.now)()
    for (const [callId, pending] of this.pendingCalls) {
      pending.abortController.abort(new Error("live voice tool call was cancelled"))
      cancelRealtimeToolApproval(this.options.sessionId, callId)
      this.record({
        callId,
        name: pending.name,
        status: "cancelled",
        durationMs: Math.max(0, now - pending.startedAt),
      })
    }
    this.pendingCalls.clear()
    this.inFlight = 0
  }

  /** Invalidate one provider-cancelled call without disturbing its siblings. */
  cancel(callId: string): void {
    const pending = this.pendingCalls.get(callId)
    if (!pending) return
    pending.abortController.abort(new Error("provider cancelled the live voice tool call"))
    cancelRealtimeToolApproval(this.options.sessionId, callId)
    this.pendingCalls.delete(callId)
    this.inFlight = Math.max(0, this.inFlight - 1)
    this.record({
      callId,
      name: pending.name,
      status: "cancelled",
      durationMs: Math.max(0, (this.options.now ?? Date.now)() - pending.startedAt),
    })
  }

  /** Handle one `function-call-arguments-done`. Never rejects. */
  async handleToolCall(call: RealtimeToolCall): Promise<void> {
    if (this.seenCallIds.has(call.callId)) return
    this.seenCallIds.add(call.callId)
    const epoch = this.epoch
    this.pendingCalls.set(call.callId, {
      name: call.name,
      startedAt: (this.options.now ?? Date.now)(),
      abortController: new AbortController(),
    })
    this.inFlight += 1

    let outcome: RealtimeToolExecutionResult
    try {
      outcome = await this.runCall(call)
    } catch (error) {
      // Defence in depth: `execute` is contracted not to throw, but a broken
      // implementation must not leave the model hanging.
      const err = error instanceof Error ? error : new Error(String(error))
      this.options.onError?.(err)
      outcome = { error: err.message }
    }

    this.completeCall(epoch, call, outcome)
  }

  private async runCall(call: RealtimeToolCall): Promise<RealtimeToolExecutionResult> {
    const { sessionId, policy, gate } = this.options

    const parsed = parseToolArguments(call.arguments)
    if ("error" in parsed) return { error: parsed.error }
    const signal = this.pendingCalls.get(call.callId)?.abortController.signal
    if (!signal) return { error: "tool call is no longer active" }

    // Only hold the microphone when a dialog is actually going up. Muting
    // around a tool that auto-allows would cut the user off mid-sentence for
    // no reason they can see.
    const willPrompt = realtimeToolWillPrompt(sessionId, call.name, policy)
    const release = willPrompt ? gate.suspend() : undefined

    try {
      const approval = await requestRealtimeToolApproval({
        sessionId,
        callId: call.callId,
        toolName: call.name,
        args: parsed.args,
        policy,
      })
      if (!approval.approved) return { error: REALTIME_TOOL_DENIED_ERROR }

      return await this.options.execute({
        sessionId,
        callId: call.callId,
        name: call.name,
        args: parsed.args,
        signal,
      })
    } finally {
      release?.()
    }
  }

  private completeCall(
    epoch: number,
    call: RealtimeToolCall,
    outcome: RealtimeToolExecutionResult
  ): void {
    // The session this call belonged to is gone. Sending a callId the current
    // session never issued is fatal on most providers.
    if (epoch !== this.epoch || !this.pendingCalls.has(call.callId)) return

    this.inFlight = Math.max(0, this.inFlight - 1)
    const pending = this.pendingCalls.get(call.callId)
    this.pendingCalls.delete(call.callId)
    this.record({
      callId: call.callId,
      name: call.name,
      status:
        outcome.error === REALTIME_TOOL_DENIED_ERROR
          ? "rejected"
          : outcome.error !== undefined
            ? "failed"
            : "completed",
      durationMs: pending ? Math.max(0, (this.options.now ?? Date.now)() - pending.startedAt) : 0,
    })

    this.options.send({
      type: "conversation-item-create",
      item: {
        type: "function-call-output",
        callId: call.callId,
        // Google routes tool responses by name, not just call id.
        name: call.name,
        output: serializeToolOutput(outcome),
      },
    })

    // Ask for the continuation only once the whole batch has answered.
    if (this.inFlight === 0) {
      this.options.send({ type: "response-create" })
    }
  }

  private record(record: RealtimeToolRecord): void {
    this.lifecycleRecords.push(record)
    this.options.onRecord?.(record)
  }
}

/**
 * Parse the model's argument JSON.
 *
 * Models do emit malformed JSON, and a throw here would skip the output the
 * model is waiting on — so the failure is turned into a tool error instead.
 */
export function parseToolArguments(
  raw: string
): { args: Record<string, unknown> } | { error: string } {
  // An empty string is how providers spell "no arguments"; JSON.parse rejects it.
  if (raw.trim() === "") return { args: {} }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { error: "tool arguments must be a JSON object" }
    }
    return { args: parsed as Record<string, unknown> }
  } catch {
    return { error: "tool arguments were not valid JSON" }
  }
}

/** `function-call-output.output` is a JSON string on every provider. */
export function serializeToolOutput(outcome: RealtimeToolExecutionResult): string {
  if (outcome.error !== undefined) return JSON.stringify({ error: outcome.error })
  try {
    return JSON.stringify(outcome.result ?? null)
  } catch {
    // Circular or otherwise unserializable results — report the shape problem
    // rather than sending a frame the provider will reject.
    return JSON.stringify({ error: "tool result could not be serialized" })
  }
}

export function createRealtimeToolRuntime(
  options: RealtimeToolRuntimeOptions
): RealtimeToolRuntime {
  return new RealtimeToolRuntime(options)
}
