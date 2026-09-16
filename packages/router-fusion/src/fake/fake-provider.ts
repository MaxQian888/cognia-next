/**
 * Deterministic Fake Provider (AGENT_TASKS D01).
 *
 * Every response is scripted: success, 429, server error, never-sent, sent and
 * silent (timeout after send), refusal, invalid JSON, tool requests and forged
 * citations. Usage is derived from text length so costs are reproducible.
 * Responses are marked `mock:` in the provider request id; a host showing a
 * Fake Provider answer must label it as simulated — it is never a real model.
 */

import type { UsageSemantics } from "../usage/normalize"
import type { RoleCallRequest, RoleCallResponse, RoleCallExecutor } from "../workflows/ports"

export const FAKE_SEMANTICS: UsageSemantics = {
  inputIncludesCacheRead: true,
  inputIncludesCacheWrite: false,
  outputIncludesReasoning: true,
}

export type FakeStep =
  | { kind: "text"; text: string; reasoningTokens?: number }
  | { kind: "json"; value: unknown }
  | { kind: "invalid_json"; text?: string }
  | { kind: "tool_call"; name: string; arguments: Record<string, unknown> }
  | { kind: "rate_limited"; retryAfterMs?: number }
  | { kind: "server_error" }
  | { kind: "not_sent" }
  | { kind: "timeout_after_send" }
  | { kind: "refusal"; message?: string }
  | { kind: "throw"; message?: string }

export type FakeScript = (request: RoleCallRequest, callIndex: number) => FakeStep

function tokensOf(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4))
}

export class FakeProvider implements RoleCallExecutor {
  readonly requests: RoleCallRequest[] = []

  constructor(private readonly script: FakeScript) {}

  async call(request: RoleCallRequest, signal: AbortSignal): Promise<RoleCallResponse> {
    this.requests.push(request)
    const index = this.requests.length - 1
    if (signal.aborted) {
      return { outcome: "error", errorClass: "cancelled", message: "aborted before send" }
    }
    const step = this.script(request, index)
    const inputTokens = request.messages.reduce((sum, m) => sum + tokensOf(m.content), 0)
    const providerRequestId = `mock:${request.attemptId}`
    switch (step.kind) {
      case "text":
      case "json":
      case "invalid_json": {
        const text =
          step.kind === "text"
            ? step.text
            : step.kind === "json"
              ? JSON.stringify(step.value)
              : (step.text ?? "{not json")
        request.onDelta?.(text)
        return {
          outcome: "ok",
          text,
          usage: {
            inputTokens,
            outputTokens: tokensOf(text),
            reasoningTokens: step.kind === "text" ? step.reasoningTokens : undefined,
          },
          semantics: FAKE_SEMANTICS,
          providerRequestId,
          finishReason: "stop",
        }
      }
      case "tool_call":
        return {
          outcome: "ok",
          text: "",
          usage: { inputTokens, outputTokens: 8 },
          semantics: FAKE_SEMANTICS,
          providerRequestId,
          finishReason: "tool_calls",
          toolCalls: [
            { id: `${providerRequestId}:tool`, name: step.name, arguments: step.arguments },
          ],
        }
      case "rate_limited":
        return {
          outcome: "error",
          errorClass: "rate_limited",
          message: "429 Too Many Requests",
          retryAfterMs: step.retryAfterMs ?? 0,
          providerRequestId,
        }
      case "server_error":
        return {
          outcome: "error",
          errorClass: "server_error",
          message: "500 Internal Server Error",
          providerRequestId,
        }
      case "not_sent":
        return { outcome: "error", errorClass: "not_sent", message: "connection refused" }
      case "timeout_after_send":
        return {
          outcome: "error",
          errorClass: "timeout_after_send",
          message: "no response before timeout",
          providerRequestId,
        }
      case "refusal":
        return {
          outcome: "error",
          errorClass: "refusal",
          message: step.message ?? "the request was refused by policy",
          usage: { inputTokens, outputTokens: 4 },
          semantics: FAKE_SEMANTICS,
          providerRequestId,
        }
      case "throw":
        throw new Error(step.message ?? "adapter crashed mid-request")
    }
  }
}

/** A script that answers every call with the same text. */
export function constantScript(text: string): FakeScript {
  return () => ({ kind: "text", text })
}

/** A script that plays the given steps in order and repeats the last one. */
export function sequenceScript(steps: FakeStep[]): FakeScript {
  return (_request, index) => steps[Math.min(index, steps.length - 1)]
}
