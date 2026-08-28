/** @jest-environment node */
import {
  __resetPluginHostRuntimesForTesting,
  hasSessionHostRuntime,
  resolvePluginHostRuntime,
} from "@/lib/plugin/runtime/host-runtime"
import type { LlmClient } from "@/lib/twin/distill/llm"

import { DEFAULT_RESOLVED_CONFIG, type ResolvedConfig } from "../config/schema"
import { bindCliSessionHostRuntime, createCliHostRuntime } from "./cli-host-runtime"

function config(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    ...DEFAULT_RESOLVED_CONFIG,
    cwd: "/work",
    provider: "openai",
    model: "gpt-test",
    providers: { openai: { apiKey: "model-key", model: "gpt-test" } },
    ...overrides,
  }
}

function client(text = "answer", usage?: { inputTokens: number; outputTokens: number }): LlmClient {
  let snapshot = { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
  return {
    complete: jest.fn(async () => {
      if (usage) {
        snapshot = { ...usage, totalTokens: usage.inputTokens + usage.outputTokens }
      }
      return text
    }),
    getUsageSnapshot: () => snapshot,
  }
}

afterEach(() => {
  __resetPluginHostRuntimesForTesting()
})

describe("chat", () => {
  it("drives the CLI's own model client without any renderer store", async () => {
    const llm = client("answer", { inputTokens: 4, outputTokens: 2 })
    const runtime = createCliHostRuntime(config(), "session-1", {
      buildClient: jest.fn(() => llm),
    })
    const chunks = []
    for await (const chunk of runtime.chat([
      { role: "system", content: "Be exact" },
      { role: "user", content: "Question" },
    ])) {
      chunks.push(chunk)
    }
    expect(llm.complete).toHaveBeenCalledWith(
      "USER:\nQuestion",
      expect.objectContaining({ system: "Be exact" })
    )
    expect(chunks).toEqual([
      { content: "answer", usage: { promptTokens: 4, completionTokens: 2, totalTokens: 6 } },
    ])
  })

  it("reports only the tokens this call spent, not the session total", async () => {
    // The client accumulates usage per instance. Reporting the running total
    // would make a plugin's second call look like it cost everything before it.
    let snapshot = { inputTokens: 100, outputTokens: 50, totalTokens: 150 }
    const llm: LlmClient = {
      complete: jest.fn(async () => {
        snapshot = { inputTokens: 110, outputTokens: 57, totalTokens: 167 }
        return "answer"
      }),
      getUsageSnapshot: () => snapshot,
    }
    const runtime = createCliHostRuntime(config(), "session-1", { buildClient: jest.fn(() => llm) })
    const chunks = []
    for await (const chunk of runtime.chat([{ role: "user", content: "q" }])) chunks.push(chunk)
    expect(chunks[0]?.usage).toEqual({
      promptTokens: 10,
      completionTokens: 7,
      totalTokens: 17,
    })
  })

  it("fails with a structured error when the session has no usable provider", async () => {
    const runtime = createCliHostRuntime(config(), "session-1", {
      buildClient: jest.fn(() => null),
    })
    await expect(
      (async () => {
        for await (const _ of runtime.chat([{ role: "user", content: "q" }])) {
          // drain
        }
      })()
    ).rejects.toMatchObject({ code: "NO_PROVIDER_AVAILABLE" })
  })
})

describe("embed", () => {
  it("uses the session's own embedding-capable provider", async () => {
    const embed = jest.fn(async () => ({
      embeddings: [[0.1, 0.2]],
      model: "text-embedding-3-small",
      provider: "openai" as const,
    }))
    const runtime = createCliHostRuntime(config(), "session-1", {
      buildClient: jest.fn(() => client()),
      embed,
    })
    await expect(runtime.embed(["source text"])).resolves.toEqual([[0.1, 0.2]])
    expect(embed).toHaveBeenCalledWith(
      ["source text"],
      expect.objectContaining({ provider: "openai", model: "text-embedding-3-small" }),
      "model-key"
    )
  })

  it("refuses when no configured provider can embed", async () => {
    const runtime = createCliHostRuntime(
      config({ provider: "anthropic", providers: { anthropic: { apiKey: "k" } } }),
      "session-1",
      { buildClient: jest.fn(() => client()) }
    )
    await expect(runtime.embed(["x"])).rejects.toMatchObject({ code: "NO_PROVIDER_AVAILABLE" })
  })
})

describe("session binding", () => {
  it("keeps two concurrent sessions on their own credentials", async () => {
    // The whole reason the CLI resolves per session: one process, two configs.
    // Crossing them would bill the wrong account and answer with the wrong model.
    const embedA = jest.fn(async () => ({
      embeddings: [[1]],
      model: "text-embedding-3-small",
      provider: "openai" as const,
    }))
    const embedB = jest.fn(async () => ({
      embeddings: [[2]],
      model: "text-embedding-3-small",
      provider: "openai" as const,
    }))
    bindCliSessionHostRuntime(
      config({ providers: { openai: { apiKey: "key-a", model: "gpt-a" } }, model: "gpt-a" }),
      "a",
      { buildClient: jest.fn(() => client("from-a")), embed: embedA }
    )
    bindCliSessionHostRuntime(
      config({ providers: { openai: { apiKey: "key-b", model: "gpt-b" } }, model: "gpt-b" }),
      "b",
      { buildClient: jest.fn(() => client("from-b")), embed: embedB }
    )

    const a = resolvePluginHostRuntime({ pluginId: "p", sessionId: "a" })
    const b = resolvePluginHostRuntime({ pluginId: "p", sessionId: "b" })
    expect(a.getDefaultModel()).toBe("gpt-a")
    expect(b.getDefaultModel()).toBe("gpt-b")

    await a.embed(["x"])
    await b.embed(["x"])
    expect(embedA).toHaveBeenCalledWith(["x"], expect.anything(), "key-a")
    expect(embedB).toHaveBeenCalledWith(["x"], expect.anything(), "key-b")
  })

  it("fails closed for a session that was never bound", () => {
    bindCliSessionHostRuntime(config(), "a")
    expect(() => resolvePluginHostRuntime({ pluginId: "p", sessionId: "ghost" })).toThrow(
      /not bound/
    )
  })

  it("fails closed for a call that names no session at all", () => {
    bindCliSessionHostRuntime(config(), "a")
    expect(() => resolvePluginHostRuntime({ pluginId: "p" })).toThrow(/per session/)
  })

  it("releases the binding through the returned disposer", () => {
    const release = bindCliSessionHostRuntime(config(), "a")
    expect(hasSessionHostRuntime("a")).toBe(true)
    release()
    expect(hasSessionHostRuntime("a")).toBe(false)
  })
})
