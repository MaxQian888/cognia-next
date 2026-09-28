import test from "node:test"
import assert from "node:assert/strict"
import { providerVisibleSendPayloadIsSafe } from "./send.ts"

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
