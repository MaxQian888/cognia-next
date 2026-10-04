import test from "node:test"
import assert from "node:assert/strict"
import { providerVisibleSendPayloadIsSafe, retainedRuntimeSendIsSafe } from "./send.ts"

test("restored history is PII-gated including nested tool results", () => {
  assert.equal(
    providerVisibleSendPayloadIsSafe({
      prompt: "continue",
      options: {
        initialConversation: [
          {
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolCallId: "read-1",
                toolName: "read",
                output: { type: "json", value: { email: "private@example.com" } },
              },
            ],
          },
        ],
      },
    }),
    false
  )
  assert.equal(
    providerVisibleSendPayloadIsSafe({
      prompt: "continue",
      options: {
        initialConversation: [{ role: "user", content: "prior request with redacted contact" }],
      },
    }),
    true
  )
})

test("a send requiring retained context refuses lost, replaced, closing, or restart-risk loops", () => {
  const current = {
    sdkSessionId: "live",
    multiTurn: true,
    q: { active: false, closed: false },
    sendOptions: { provider: "openai", cwd: "/a", transcriptInvalidationId: "g1" },
  }
  const options = {
    provider: "openai",
    cwd: "/a",
    transcriptInvalidationId: "g1",
    expectedRuntimeSessionId: "live",
  }
  assert.equal(retainedRuntimeSendIsSafe(current, options), true)
  assert.equal(retainedRuntimeSendIsSafe(undefined, options), false)
  assert.equal(
    retainedRuntimeSendIsSafe({ ...current, sdkSessionId: "replacement" }, options),
    false
  )
  assert.equal(retainedRuntimeSendIsSafe({ ...current, q: { active: true } }, options), false)
  assert.equal(retainedRuntimeSendIsSafe({ ...current, q: { closed: true } }, options), false)
  assert.equal(retainedRuntimeSendIsSafe(current, { ...options, cwd: "/b" }), false)
  assert.equal(
    retainedRuntimeSendIsSafe(current, { ...options, transcriptInvalidationId: "g2" }),
    false
  )
  assert.equal(retainedRuntimeSendIsSafe(undefined, { initialConversation: [] }), true)
})

test("provider-visible sends are rejected when any prompt surface leaks PII", () => {
  assert.equal(
    providerVisibleSendPayloadIsSafe({
      prompt: "summarize this",
      options: { systemPrompt: "be concise", appendSystemPrompt: "use bullets" },
    }),
    true
  )
  assert.equal(
    providerVisibleSendPayloadIsSafe({
      prompt: "email alice@example.com",
      options: { systemPrompt: "be concise" },
    }),
    false
  )
  assert.equal(
    providerVisibleSendPayloadIsSafe({
      prompt: "summarize this",
      options: { appendSystemPrompt: "token sk-proj-abc123def456ghi789jkl012" },
    }),
    false
  )
  assert.equal(
    providerVisibleSendPayloadIsSafe({
      prompt: "summarize this",
      options: {
        claudeAgentSdk: {
          version: 1,
          planModeInstructions: "send the plan to alice@example.com",
        },
      },
    }),
    false
  )
  assert.equal(
    providerVisibleSendPayloadIsSafe({
      prompt: "summarize this",
      options: {
        agents: { reviewer: { description: "fixture", prompt: "contact alice@example.com" } },
      },
    }),
    false
  )
})

test("plugin tool metadata is gated before SDK dispatch without scanning bridge credentials", () => {
  assert.equal(
    providerVisibleSendPayloadIsSafe({
      prompt: "hello",
      options: {
        pluginTools: [
          {
            name: "safe",
            description: "Contact private@example.com",
            jsonSchema: { type: "object" },
          },
        ],
      },
    }),
    false
  )
  assert.equal(
    providerVisibleSendPayloadIsSafe({
      prompt: "hello",
      options: {
        pluginTools: [
          {
            name: "safe",
            description: "Tool",
            jsonSchema: {
              type: "object",
              properties: { email: { type: "string", default: "private@example.com" } },
            },
          },
        ],
      },
    }),
    false
  )
})
