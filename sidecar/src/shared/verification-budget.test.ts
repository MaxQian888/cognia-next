import test from "node:test"
import assert from "node:assert/strict"
import { streamText, stepCountIs, tool } from "ai"
import type { PrepareStepFunction, ToolSet } from "ai"
import { createOpenAI } from "@ai-sdk/openai"
import { z } from "zod"
import { createVerificationBudget, withVerificationFeedback } from "./verification-budget.ts"

function fixture() {
  let mono = 0
  let epoch = 1000
  const budget = createVerificationBudget({ monotonic: () => mono, epoch: () => epoch })
  budget.reset({ startedAtEpochMs: 1000, deadlineEpochMs: 361_000 })
  return {
    budget,
    advance(ms: number) {
      mono += ms
      epoch += ms
    },
    jumpWall(ms: number) {
      epoch += ms
    },
  }
}

test("budget reserves concurrent batches and refunds only unused wall time", () => {
  const f = fixture()
  assert.equal(f.budget.snapshot().verificationRemainingMs, 180_000)
  const a = f.budget.reserveBatch()!
  const b = f.budget.reserveBatch()!
  assert.equal(f.budget.snapshot().verificationRemainingMs, 150_000)
  f.advance(5000)
  a.finish()
  a.finish()
  assert.equal(f.budget.snapshot().verificationSpentMs, 5000)
  b.finish()
  assert.equal(f.budget.snapshot().verificationRemainingMs, 170_000)
})

test("budget remains monotonic when wall time changes and keeps delivery reserve", () => {
  const f = fixture()
  f.advance(340_000)
  f.jumpWall(-100_000)
  assert.equal(f.budget.snapshot().availableBatchMs, 5000)
  const lease = f.budget.reserveBatch()!
  f.advance(5001)
  assert.equal(lease.remainingMs(), 0)
  lease.finish()
  assert.equal(f.budget.reserveBatch(), null)
})

test("a new or absent turn invalidates old leases without charging the next turn", () => {
  const f = fixture()
  const lease = f.budget.reserveBatch()!
  f.budget.reset({ startedAtEpochMs: 1000, deadlineEpochMs: 361_000 })
  assert.equal(lease.current(), false)
  lease.finish()
  assert.equal(f.budget.snapshot().verificationSpentMs, 0)
  f.budget.reset(undefined)
  assert.equal(f.budget.snapshot().enabled, false)
  assert.equal(f.budget.reserveBatch(), null)
  assert.throws(() => f.budget.reset({ startedAtEpochMs: 1, deadlineEpochMs: NaN }), /Invalid/)
})

test("step feedback composes active tools and replaces only its own carried tail", async () => {
  const f = fixture()
  const original = { role: "user" as const, content: "keep complete validation" }
  const prepare = withVerificationFeedback(f.budget, async () => ({
    activeTools: ["read", "ToolSearch"],
  }))
  const options = {
    initialInstructions: "stable rules",
    instructions: "stable rules",
    messages: [original],
  } as Parameters<PrepareStepFunction<ToolSet>>[0]
  const first = await prepare(options)
  const response = { role: "assistant" as const, content: "continue" }
  f.advance(10_000)
  const second = await prepare({ ...options, messages: [...first!.messages!, response] })
  assert.deepEqual(second?.activeTools, ["read", "ToolSearch"])
  assert.equal(
    second?.instructions,
    undefined,
    "the caller's system instructions are not overridden"
  )
  assert.deepEqual(second?.messages?.slice(0, -1), [original, response])
  assert.match(String(second?.messages?.at(-1)?.content), /remaining 350s/)
  assert.match(
    String(second?.messages?.at(-1)?.content),
    /Preserve every original acceptance requirement/
  )
  assert.equal(options.messages.length, 1)
  // Exact text copied by a caller is still caller-owned and must be preserved.
  const lookalike = { ...second!.messages!.at(-1)! }
  const third = await prepare({ ...options, messages: [original, lookalike] })
  assert.equal(third?.messages?.[1], lookalike)
  f.budget.reset(undefined)
  assert.deepEqual(await prepare({ ...options, messages: second!.messages! }), {
    activeTools: ["read", "ToolSearch"],
    messages: [original, response],
  })
  assert.deepEqual(await prepare(options), { activeTools: ["read", "ToolSearch"] })
})

test("step feedback preserves callback instructions, provider options and tool-result adjacency", async () => {
  const f = fixture()
  const instructions = [
    {
      role: "system" as const,
      content: "fixed",
      providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
    },
  ]
  const history = [
    { role: "user" as const, content: "check" },
    {
      role: "assistant" as const,
      content: [{ type: "tool-call" as const, toolCallId: "one", toolName: "check", input: {} }],
    },
    {
      role: "tool" as const,
      content: [
        {
          type: "tool-result" as const,
          toolCallId: "one",
          toolName: "check",
          output: { type: "text" as const, value: "ok" },
        },
      ],
    },
  ]
  const before = JSON.stringify(history)
  const prepare = withVerificationFeedback(f.budget, async () => ({
    instructions,
    messages: history,
    activeTools: ["check"],
    providerOptions: { test: { keep: true } },
  }))
  const result = await prepare({ messages: [] } as unknown as Parameters<
    PrepareStepFunction<ToolSet>
  >[0])
  assert.equal(result?.instructions, instructions)
  assert.deepEqual(result?.providerOptions, { test: { keep: true } })
  assert.deepEqual(result?.messages?.slice(0, -1), history)
  assert.equal(JSON.stringify(history), before)
})

test("actual SDK keeps system and prior history stable while refreshing only the request tail", async () => {
  const f = fixture()
  const requests: Array<{ messages: Array<{ role: string; content: unknown }>; tools: unknown }> =
    []
  const model = createOpenAI({
    apiKey: "controlled-no-real-key",
    baseURL: "https://controlled.invalid/v1",
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body))
      requests.push(body)
      f.advance(1000)
      const check = requests.length < 8
      const chunk = {
        id: `local-${requests.length}`,
        object: "chat.completion.chunk",
        model: "controlled",
        choices: [
          {
            index: 0,
            delta: check
              ? {
                  tool_calls: [
                    {
                      index: 0,
                      id: `call-${requests.length}`,
                      type: "function",
                      function: { name: "check", arguments: "{}" },
                    },
                  ],
                }
              : { content: "done" },
            finish_reason: null as string | null,
          },
        ],
      }
      const initial = `data: ${JSON.stringify(chunk)}\n\n`
      const finish = {
        ...chunk,
        choices: [{ index: 0, delta: {}, finish_reason: check ? "tool_calls" : "stop" }],
      }
      return new Response(
        initial +
          `data: ${JSON.stringify({ ...finish, usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } })}\n\ndata: [DONE]\n\n`,
        { headers: { "content-type": "text/event-stream" } }
      )
    },
  }).chat("controlled")
  const initialMessages = [
    {
      role: "user" as const,
      content: "Keep every required acceptance check. " + "stable context ".repeat(1000),
    },
  ]
  const initialBefore = JSON.stringify(initialMessages)
  const tools: ToolSet = {
    check: tool({ inputSchema: z.object({}), execute: async () => "checked" }),
  }
  const result = streamText({
    model,
    instructions: "Stable safety and validation rules.",
    messages: initialMessages,
    tools,
    stopWhen: stepCountIs(8),
    prepareStep: withVerificationFeedback(f.budget),
  })
  await result.consumeStream()
  assert.equal(requests.length, 8)
  const systems = requests.map((request) =>
    JSON.stringify(request.messages.filter((message) => message.role === "system"))
  )
  assert.equal(new Set(systems).size, 1, "a clock must never invalidate the system prefix")
  assert.equal(new Set(requests.map((request) => JSON.stringify(request.tools))).size, 1)
  for (const [index, request] of requests.entries()) {
    assert.equal(
      request.messages.filter((message) =>
        JSON.stringify(message).includes("Runtime execution budget")
      ).length,
      1
    )
    assert.equal(request.messages.at(-1)?.role, "user")
    assert.match(String(request.messages.at(-1)?.content), /Runtime execution budget/)
    if (index)
      assert.deepEqual(
        request.messages.slice(0, requests[index - 1]!.messages.length - 1),
        requests[index - 1]!.messages.slice(0, -1),
        "everything before the previous temporary tail must remain cacheable"
      )
  }
  assert.equal(JSON.stringify(initialMessages), initialBefore)
  assert.doesNotMatch(JSON.stringify((await result.response).messages), /Runtime execution budget/)
})
