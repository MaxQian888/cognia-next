import type { RoleCallRequest } from "../workflows/ports"
import {
  FAKE_SEMANTICS,
  FakeProvider,
  constantScript,
  sequenceScript,
  type FakeStep,
} from "./fake-provider"

function request(overrides: Partial<RoleCallRequest> = {}): RoleCallRequest {
  return {
    attemptId: "attempt-1",
    messages: [{ role: "user", content: "hello there" }],
    maxOutputTokens: 256,
    toolPolicyId: null,
    ...overrides,
  } as RoleCallRequest
}

const live = () => new AbortController().signal

async function answer(steps: FakeStep[], input = request(), signal = live()) {
  const provider = new FakeProvider(sequenceScript(steps))
  return { provider, response: await provider.call(input, signal) }
}

describe("FakeProvider", () => {
  it("answers text with usage derived from the prompt and the answer", async () => {
    const deltas: string[] = []
    const { provider, response } = await answer(
      [{ kind: "text", text: "general kenobi", reasoningTokens: 7 }],
      request({ onDelta: (text: string) => void deltas.push(text) } as Partial<RoleCallRequest>)
    )
    expect(response).toEqual({
      outcome: "ok",
      text: "general kenobi",
      // "hello there" is 11 chars → 3 tokens; "general kenobi" is 14 → 4.
      usage: { inputTokens: 3, outputTokens: 4, reasoningTokens: 7 },
      semantics: FAKE_SEMANTICS,
      // Every answer is marked simulated at the provider-request id.
      providerRequestId: "mock:attempt-1",
      finishReason: "stop",
    })
    expect(deltas).toEqual(["general kenobi"])
    expect(provider.requests).toHaveLength(1)
  })

  it("serializes a json step and leaves an invalid_json step unparseable", async () => {
    const { response } = await answer([{ kind: "json", value: { answer: 42 } }])
    expect(response).toMatchObject({ outcome: "ok", text: '{"answer":42}' })

    const broken = await answer([{ kind: "invalid_json" }])
    expect(broken.response).toMatchObject({ outcome: "ok", text: "{not json" })
    expect(() => JSON.parse((broken.response as { text: string }).text)).toThrow()

    const custom = await answer([{ kind: "invalid_json", text: "[[[" }])
    expect(custom.response).toMatchObject({ text: "[[[" })
  })

  it("asks for a tool without producing any text", async () => {
    const { response } = await answer([
      { kind: "tool_call", name: "read_file", arguments: { path: "README.md" } },
    ])
    expect(response).toMatchObject({
      outcome: "ok",
      text: "",
      finishReason: "tool_calls",
      toolCalls: [
        { id: "mock:attempt-1:tool", name: "read_file", arguments: { path: "README.md" } },
      ],
    })
  })

  it("plays each transport failure with the error class the ledger books it under", async () => {
    await expect(answer([{ kind: "rate_limited" }]).then((a) => a.response)).resolves.toMatchObject(
      {
        outcome: "error",
        errorClass: "rate_limited",
        retryAfterMs: 0,
        providerRequestId: "mock:attempt-1",
      }
    )
    await expect(
      answer([{ kind: "rate_limited", retryAfterMs: 250 }]).then((a) => a.response)
    ).resolves.toMatchObject({ retryAfterMs: 250 })
    await expect(answer([{ kind: "server_error" }]).then((a) => a.response)).resolves.toMatchObject(
      {
        errorClass: "server_error",
      }
    )
    // Never sent carries no provider request id: there was no request.
    await expect(answer([{ kind: "not_sent" }]).then((a) => a.response)).resolves.toEqual({
      outcome: "error",
      errorClass: "not_sent",
      message: "connection refused",
    })
    await expect(
      answer([{ kind: "timeout_after_send" }]).then((a) => a.response)
    ).resolves.toMatchObject({
      errorClass: "timeout_after_send",
      providerRequestId: "mock:attempt-1",
    })
  })

  it("bills a refusal: the model answered, it just refused", async () => {
    const { response } = await answer([{ kind: "refusal" }])
    expect(response).toMatchObject({
      outcome: "error",
      errorClass: "refusal",
      message: "the request was refused by policy",
      usage: { inputTokens: 3, outputTokens: 4 },
      semantics: FAKE_SEMANTICS,
    })
    const spoken = await answer([{ kind: "refusal", message: "no" }])
    expect(spoken.response).toMatchObject({ message: "no" })
  })

  it("throws for the adapter-crash step", async () => {
    await expect(answer([{ kind: "throw" }])).rejects.toThrow("adapter crashed mid-request")
    await expect(answer([{ kind: "throw", message: "boom" }])).rejects.toThrow("boom")
  })

  it("does not send an already-cancelled call", async () => {
    const controller = new AbortController()
    controller.abort()
    const { response } = await answer(
      [{ kind: "text", text: "never" }],
      request(),
      controller.signal
    )
    expect(response).toEqual({
      outcome: "error",
      errorClass: "cancelled",
      message: "aborted before send",
    })
  })

  it("scripts by call index: a sequence repeats its last step, a constant never varies", async () => {
    const provider = new FakeProvider(
      sequenceScript([{ kind: "server_error" }, { kind: "text", text: "second" }])
    )
    const first = await provider.call(request(), live())
    const second = await provider.call(request({ attemptId: "attempt-2" }), live())
    const third = await provider.call(request({ attemptId: "attempt-3" }), live())
    expect(first).toMatchObject({ errorClass: "server_error" })
    expect(second).toMatchObject({ text: "second" })
    expect(third).toMatchObject({ text: "second" })

    const constant = new FakeProvider(constantScript("same"))
    await expect(constant.call(request(), live())).resolves.toMatchObject({ text: "same" })
    await expect(constant.call(request({ attemptId: "attempt-2" }), live())).resolves.toMatchObject(
      { text: "same" }
    )
  })
})
