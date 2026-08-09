/** @jest-environment jsdom */
import type { UIMessage } from "ai"

import { buildLiveVoiceRuntimeBindings } from "./runtime-bindings"
import type { LiveVoiceCapabilities } from "./types"

const CAPABILITIES: LiveVoiceCapabilities = {
  supportsTools: true,
  supportsServerVad: true,
  supportsBargeIn: true,
  supportsInputTranscript: true,
  supportsOutputTranscript: true,
  inputSampleRate: 24_000,
  outputSampleRate: 24_000,
  requiresRelay: false,
}

const LIMITS = { turnLimit: 12, characterLimit: 16_000 }

function history(): UIMessage[] {
  return [
    { id: "m1", role: "user", parts: [{ type: "text", text: "who won" }] },
    { id: "m2", role: "assistant", parts: [{ type: "text", text: "the badgers" }] },
  ] as unknown as UIMessage[]
}

function deps(overrides: Record<string, unknown> = {}) {
  return {
    listMessages: jest.fn(async () => history()),
    buildPluginToolsManifest: jest.fn(async () => [
      { name: "search_notes", description: "search", jsonSchema: {}, pluginId: "notes" },
    ]),
    executeTool: jest.fn(async () => ({ result: null })),
    ...overrides,
  }
}

function options(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: "s1",
    capabilities: CAPABILITIES,
    policy: {},
    limits: LIMITS,
    ...overrides,
  }
}

describe("buildLiveVoiceRuntimeBindings", () => {
  it("advertises the plugin manifest as realtime tools", async () => {
    const bindings = await buildLiveVoiceRuntimeBindings(options({ deps: deps() }))

    expect(bindings.tools).toEqual([
      {
        type: "function",
        name: "search_notes",
        description: "search",
        parameters: { type: "object", properties: {}, additionalProperties: false },
      },
    ])
  })

  it("attaches an executor bound to the chat session", async () => {
    const d = deps()
    const bindings = await buildLiveVoiceRuntimeBindings(options({ deps: d }))

    expect(bindings.toolExecution?.sessionId).toBe("s1")
    await bindings.toolExecution?.execute({
      sessionId: "s1",
      callId: "c1",
      name: "search_notes",
      args: {},
    })
    expect(d.executeTool).toHaveBeenCalled()
  })

  it("carries the permission policy through untouched", async () => {
    const policy = { toolRules: { search_notes: "allow" as const } }
    const bindings = await buildLiveVoiceRuntimeBindings(options({ policy, deps: deps() }))

    expect(bindings.toolExecution?.policy).toBe(policy)
  })

  it("offers no tools to a provider whose tool support is dormant", async () => {
    const bindings = await buildLiveVoiceRuntimeBindings(
      options({ capabilities: { ...CAPABILITIES, supportsTools: false }, deps: deps() })
    )

    expect(bindings.tools).toBeUndefined()
    expect(bindings.toolExecution).toBeUndefined()
  })

  it("offers no tools without a chat session to attribute approvals to", async () => {
    const bindings = await buildLiveVoiceRuntimeBindings(
      options({ sessionId: undefined, deps: deps() })
    )

    expect(bindings.toolExecution).toBeUndefined()
  })

  it("attaches no executor when every tool was dropped", async () => {
    // Advertising nothing but keeping an executor would be dead weight.
    const bindings = await buildLiveVoiceRuntimeBindings(
      options({
        deps: deps({
          buildPluginToolsManifest: jest.fn(async () => [
            { name: "not a valid name", description: "", jsonSchema: {}, pluginId: "p" },
          ]),
        }),
      })
    )

    expect(bindings.tools).toBeUndefined()
    expect(bindings.toolExecution).toBeUndefined()
    expect(bindings.droppedTools).toHaveLength(1)
  })

  it("reports dropped tools for diagnostics", async () => {
    const bindings = await buildLiveVoiceRuntimeBindings(
      options({
        deps: deps({
          buildPluginToolsManifest: jest.fn(async () => [
            { name: "ok_tool", description: "", jsonSchema: {}, pluginId: "p" },
            { name: "bad name", description: "", jsonSchema: {}, pluginId: "p" },
          ]),
        }),
      })
    )

    expect(bindings.tools).toHaveLength(1)
    expect(bindings.droppedTools).toEqual([
      { name: "bad name", pluginId: "p", reason: "invalid-name" },
    ])
  })

  it("seeds the conversation from the session history", async () => {
    const bindings = await buildLiveVoiceRuntimeBindings(options({ deps: deps() }))

    expect(bindings.contextTranscript).toContain("User: who won")
    expect(bindings.contextTranscript).toContain("Assistant: the badgers")
  })

  it("skips the seed when there is no session", async () => {
    const d = deps()
    const bindings = await buildLiveVoiceRuntimeBindings(options({ sessionId: undefined, deps: d }))

    expect(bindings.contextTranscript).toBeUndefined()
    expect(d.listMessages).not.toHaveBeenCalled()
  })

  it("skips the seed for an empty session rather than sending a bare header", async () => {
    const bindings = await buildLiveVoiceRuntimeBindings(
      options({ deps: deps({ listMessages: jest.fn(async () => []) }) })
    )

    expect(bindings.contextTranscript).toBeUndefined()
  })

  it("still starts when the history cannot be read", async () => {
    // A voice session with no context beats no voice session.
    const bindings = await buildLiveVoiceRuntimeBindings(
      options({
        deps: deps({
          listMessages: jest.fn(async () => {
            throw new Error("dexie is closed")
          }),
        }),
      })
    )

    expect(bindings.contextTranscript).toBeUndefined()
    expect(bindings.tools).toHaveLength(1)
  })

  it("still starts when the plugin manifest cannot be built", async () => {
    const bindings = await buildLiveVoiceRuntimeBindings(
      options({
        deps: deps({
          buildPluginToolsManifest: jest.fn(async () => {
            throw new Error("plugin store not initialised")
          }),
        }),
      })
    )

    expect(bindings.tools).toBeUndefined()
    expect(bindings.contextTranscript).toContain("User: who won")
  })
})
