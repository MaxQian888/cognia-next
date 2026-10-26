import type { AppSettings } from "@cognia/agent-config-types"
import type { LlmClient } from "@/lib/twin/distill/llm"
import {
  HarnessModelUnavailableError,
  HarnessPiiBlockedError,
  callHarnessModel,
  clientForRole,
  roleModel,
  type HarnessModelCallInput,
  type HarnessModelDeps,
} from "./model-call"

function client(over: Partial<LlmClient> & { answer?: string; fail?: boolean } = {}): LlmClient {
  return {
    reportsCallUsage: true,
    model: "judge-model",
    complete: async (_prompt, options) => {
      options?.onUsage?.({
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 1,
        cacheCreationTokens: 0,
      })
      if (over.fail) throw new Error("provider down")
      return over.answer ?? '{"ok":true}'
    },
    ...over,
  }
}

function deps(c: LlmClient | null, booked: unknown[] = []): HarnessModelDeps {
  return {
    getSettings: async () => ({}) as AppSettings,
    buildClient: () => c,
    bookUsage: async (input) => {
      booked.push(input)
      return { costUsd: 0.003, costKnown: true }
    },
  }
}

const call = (over: Partial<HarnessModelCallInput> = {}): HarnessModelCallInput => ({
  role: "selector",
  model: { providerId: "openai", model: "gpt" },
  system: "Compare runs.",
  prompt: "Run R1 did well.",
  maxTokens: 500,
  runId: "run-1",
  operationId: "harness:run-1:select:1",
  signal: new AbortController().signal,
  ...over,
})

describe("roleModel", () => {
  it("prefers the run's choice, lets the composer inherit the editor, else uses the agent's own", () => {
    const agent = { providerId: "anthropic", model: "sonnet" }
    expect(roleModel("selector", { selector: { model: "cheap" } }, agent)).toEqual({
      model: "cheap",
    })
    expect(roleModel("composer", { editor: { providerId: "x", model: "y" } }, agent)).toEqual({
      providerId: "x",
      model: "y",
    })
    expect(roleModel("reflector", {}, agent)).toEqual(agent)
    expect(roleModel("reflector", { reflector: {} }, {})).toEqual({})
  })
})

describe("callHarnessModel", () => {
  it("calls the role's model and books the call's own usage", async () => {
    const booked: unknown[] = []
    const result = await callHarnessModel(call(), deps(client(), booked))
    expect(result.text).toBe('{"ok":true}')
    expect(result.model).toBe("judge-model")
    expect(result.usage).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      costUsd: 0.003,
      costUnknown: false,
    })
    expect(booked).toEqual([
      {
        operationId: "harness:run-1:select:1",
        sessionId: "harness:run-1",
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          cacheReadTokens: 1,
          providerId: "openai",
          model: "judge-model",
          runId: "run-1",
        },
      },
    ])
  })

  it("falls back to the cumulative snapshot when the client cannot report one call", async () => {
    let snapshot = { inputTokens: 100, outputTokens: 50, totalTokens: 150 }
    const c: LlmClient = {
      complete: async () => {
        snapshot = { inputTokens: 130, outputTokens: 60, totalTokens: 190 }
        return "text"
      },
      getUsageSnapshot: () => snapshot,
    }
    const result = await callHarnessModel(call(), deps(c))
    expect(result.usage).toMatchObject({ inputTokens: 30, outputTokens: 10 })
  })

  it("books a failed call and rethrows", async () => {
    const booked: unknown[] = []
    await expect(callHarnessModel(call(), deps(client({ fail: true }), booked))).rejects.toThrow(
      "provider down"
    )
    expect(booked).toHaveLength(1)
  })

  it("reports unknown cost when nothing priced it", async () => {
    const d = deps(client())
    d.bookUsage = async () => {
      throw new Error("db closed")
    }
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {})
    const result = await callHarnessModel(call(), d)
    expect(result.usage.costUnknown).toBe(true)
    warn.mockRestore()
    const silent: LlmClient = { complete: async () => "x" }
    expect((await callHarnessModel(call(), deps(silent))).usage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      costUnknown: true,
    })
  })

  it("refuses personal data and missing clients before calling", async () => {
    const complete = jest.fn()
    await expect(
      callHarnessModel(call({ prompt: "Mail jane.doe@example.com" }), deps({ complete }))
    ).rejects.toBeInstanceOf(HarnessPiiBlockedError)
    expect(complete).not.toHaveBeenCalled()
    await expect(callHarnessModel(call(), deps(null))).rejects.toBeInstanceOf(
      HarnessModelUnavailableError
    )
    const aborted = new AbortController()
    aborted.abort()
    await expect(
      callHarnessModel(call({ signal: aborted.signal }), deps(client()))
    ).rejects.toThrow()
  })
})

describe("clientForRole", () => {
  it("needs settings", async () => {
    expect(
      await clientForRole({}, { getSettings: async () => null, buildClient: () => client() })
    ).toBeNull()
  })
})
