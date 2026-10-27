import type { UIMessage } from "ai"
import { createDiagnostic } from "@cognia/diagnostics"
import {
  canContinueChat,
  chatTurnOutcomeOf,
  continuationRuntimeOf,
  mergeChatTurnMetadata,
  pickChatContinuationMetadata,
  continuationMessageId,
} from "./continuation"

const user = (state: string, retryable = false): UIMessage => ({
  id: "u1",
  role: "user",
  parts: [{ type: "text", text: "Build it" }],
  metadata: { chatTurnOutcome: { state, revision: 2, retryable } },
})

it.each(["interrupted", "running"])(
  "can continue an idle %s turn, including reloaded history",
  (state) => {
    expect(canContinueChat({ status: "idle", messages: [user(state)] })).toBe(true)
  }
)

it("requires the latest user turn to be recoverable and never resumes a live/queued turn", () => {
  expect(
    canContinueChat({
      status: "idle",
      messages: [user("interrupted"), { ...user("completed"), id: "u2" }],
    })
  ).toBe(false)
  expect(canContinueChat({ status: "streaming", messages: [user("interrupted")] })).toBe(false)
  expect(canContinueChat({ status: "awaiting_approval", messages: [user("interrupted")] })).toBe(
    false
  )
  expect(canContinueChat({ status: "idle", messages: [user("interrupted")], queued: true })).toBe(
    false
  )
  expect(canContinueChat({ status: "idle", messages: [] })).toBe(false)
  expect(canContinueChat({ status: "idle", messages: [user("failed", true)] })).toBe(true)
  expect(canContinueChat({ status: "idle", messages: [user("failed")] })).toBe(false)
})

it.each(["timeout", "networkUnreachable", "sidecarExited"] as const)(
  "offers continuation for %s",
  (code) => {
    expect(
      canContinueChat({
        status: "error",
        messages: [user("failed")],
        diagnostic: createDiagnostic(code, { source: "chat" }),
      })
    ).toBe(true)
  }
)

it.each(["quotaExceeded", "rateLimited", "unauthorized"] as const)(
  "keeps %s on its recovery surface",
  (code) => {
    const diagnostic = createDiagnostic(code, { source: "chat" })
    expect(canContinueChat({ status: "error", messages: [user("interrupted")], diagnostic })).toBe(
      false
    )
  }
)

it("supports legacy transient errors without making arbitrary failures resumable", () => {
  expect(
    canContinueChat({
      status: "error",
      messages: [user("completed")],
      diagnostic: createDiagnostic("timeout", { source: "chat" }),
    })
  ).toBe(false)
  expect(
    canContinueChat({
      status: "error",
      messages: [user("failed")],
      errorMessage: "Request timeout",
    })
  ).toBe(true)
  expect(
    canContinueChat({
      status: "error",
      messages: [user("failed")],
      errorMessage: "Invalid API key",
    })
  ).toBe(false)
  expect(chatTurnOutcomeOf({ chatTurnOutcome: { state: "interrupted" } })).toBeNull()
})

it("retains the latest outcome and runtime across stale streaming snapshots", () => {
  const previous = {
    chatTurnOutcome: { state: "interrupted", revision: 3, retryable: true },
    continuationRuntime: { kind: "external", agentId: "gemini" },
  }
  expect(
    mergeChatTurnMetadata(
      { chatTurnOutcome: { state: "running", revision: 2, retryable: true } },
      previous
    )
  ).toEqual(previous)
  expect(mergeChatTurnMetadata(undefined, previous)).toEqual(previous)
  const complete = { chatTurnOutcome: { state: "completed", revision: 4, retryable: false } }
  expect(mergeChatTurnMetadata(complete, previous)).toEqual({
    ...complete,
    continuationRuntime: previous.continuationRuntime,
  })
})

it("keeps builtin, external and stamped Host routes and rejects malformed identities", () => {
  for (const runtime of [
    { kind: "builtin" },
    { kind: "external", agentId: "codex" },
    { kind: "host", configId: "a", revision: "v1", lifecycleGeneration: 3 },
  ]) {
    expect(continuationRuntimeOf({ continuationRuntime: runtime })).toEqual(runtime)
  }
  expect(
    continuationRuntimeOf({ continuationRuntime: { kind: "host", configId: "a" } })
  ).toBeUndefined()
  expect(
    continuationRuntimeOf({ continuationRuntime: { kind: "external", agentId: "" } })
  ).toBeUndefined()
})

it("keeps only validated shared continuation fields and uses the remote anchor identity", () => {
  const metadata = {
    continuationOf: "remote-user",
    continuationRuntime: { kind: "external", agentId: "ext-1" },
    secret: "must not propagate",
  }
  expect(pickChatContinuationMetadata(metadata)).toEqual({
    continuationOf: "remote-user",
    continuationRuntime: { kind: "external", agentId: "ext-1" },
  })
  expect(pickChatContinuationMetadata({ continuationRuntime: { kind: "host" } })).toBeUndefined()
  expect(
    continuationMessageId({
      ...user("interrupted"),
      metadata: { collaboration: { remoteMessageId: "remote-user" } },
    })
  ).toBe("remote-user")
})
