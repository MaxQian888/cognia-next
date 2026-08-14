/** @jest-environment jsdom */
/**
 * Tests for wasm-loader.ts
 *
 * The loader is mostly an IPC façade so we mock `@tauri-apps/api/core` and
 * assert that the right commands are invoked with the right payload.
 */

import type { PluginManifest } from "@/types/plugin"

const invokeMock = jest.fn()
const transportCallMock = jest.fn()

jest.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}))

jest.mock("@/lib/tauri/transport-instance", () => ({
  transport: { call: (...args: unknown[]) => transportCallMock(...args) },
}))

import {
  isWasmHostAvailable,
  loadWasmDefinition,
  callWasmExport,
  unloadWasmPlugin,
  buildWasmToolDefinitions,
  buildWasmNodeDefs,
} from "./wasm-loader"
import type { PluginToolContext } from "@/types/plugin"
import type { StepExecutionContext } from "@/types/workflow/visual"

const baseManifest: PluginManifest = {
  id: "demo.wasm",
  name: "Demo",
  version: "0.0.1",
  description: "x",
  type: "wasm",
  capabilities: [],
  wasmMain: "main.wasm",
  wasm: { apiVersion: "0.1.0" },
  permissions: ["notification"],
}

function setTauri(present: boolean) {
  if (present) {
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      get: () => ({}),
    })
  } else {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    delete (window as Record<string, unknown>).__TAURI_INTERNALS__
  }
}

beforeEach(() => {
  invokeMock.mockReset()
  transportCallMock.mockReset()
  delete (globalThis as Record<string, unknown>).__COGNIA_HEADLESS__
})

describe("isWasmHostAvailable", () => {
  it("returns true for either a Tauri or headless native host", () => {
    setTauri(false)
    expect(isWasmHostAvailable()).toBe(false)
    ;(globalThis as Record<string, unknown>).__COGNIA_HEADLESS__ = true
    expect(isWasmHostAvailable()).toBe(true)
    delete (globalThis as Record<string, unknown>).__COGNIA_HEADLESS__
    setTauri(true)
    expect(isWasmHostAvailable()).toBe(true)
  })
})

describe("buildWasmToolDefinitions", () => {
  beforeEach(() => setTauri(true))

  it("maps manifest.tools to PluginTools that dispatch through the tool-execute export", async () => {
    invokeMock.mockResolvedValue(JSON.stringify({ formatted: "fn main() {}" }))
    const manifest: PluginManifest = {
      ...baseManifest,
      tools: [
        {
          name: "format_rust",
          description: "Format a Rust source string",
          parametersSchema: { type: "object", properties: { source: { type: "string" } } },
        },
      ],
    }

    const tools = buildWasmToolDefinitions(manifest, "wasm-gen-1")

    expect(tools).toHaveLength(1)
    expect(tools[0].name).toBe("demo.wasm:format_rust")
    expect(tools[0].pluginId).toBe("demo.wasm")
    expect(tools[0].definition).toEqual({
      name: "format_rust",
      description: "Format a Rust source string",
      parametersSchema: { type: "object", properties: { source: { type: "string" } } },
    })

    const result = await tools[0].execute({ source: "fn main(){}" }, {} as PluginToolContext)

    // The guest's single `tool-execute` export dispatches by the `kind` field;
    // the host's extract_kind reads it, so the tool name must ride in the payload.
    expect(invokeMock).toHaveBeenCalledWith("plugin_wasm_call", {
      pluginId: "demo.wasm",
      generation: "wasm-gen-1",
      exportName: "tool-execute",
      payloadJson: JSON.stringify({ kind: "format_rust", source: "fn main(){}" }),
    })
    expect(result).toEqual({ formatted: "fn main() {}" })
  })

  it("returns an empty list when the manifest declares no tools", () => {
    expect(buildWasmToolDefinitions(baseManifest)).toEqual([])
  })

  it("keeps an unbound manifest tool fenced from future runtime generations", async () => {
    const tools = buildWasmToolDefinitions({
      ...baseManifest,
      tools: [
        {
          name: "unbound",
          description: "Unbound tool",
          parametersSchema: { type: "object" },
        },
      ],
    })

    await expect(tools[0].execute({}, {} as PluginToolContext)).rejects.toThrow(
      "not bound to a runtime generation"
    )
    expect(invokeMock).not.toHaveBeenCalled()
  })
})

describe("buildWasmNodeDefs", () => {
  beforeEach(() => setTauri(true))

  const nodeManifest: PluginManifest = {
    ...baseManifest,
    workflows: {
      nodes: [
        {
          kind: "action.format",
          typeVersion: 1,
          category: "plugin",
          label: "Format",
          description: "Format source",
          iconName: "Box",
          paramsSchema: { type: "object", properties: { source: { type: "string" } } },
          retryable: false,
          timeoutMs: 5000,
        },
      ],
    },
  }

  it("projects manifest.workflows.nodes into executors that route through workflow-node-execute", async () => {
    invokeMock.mockResolvedValue(JSON.stringify({ formatted: "ok" }))
    const defs = buildWasmNodeDefs(nodeManifest, "wasm-gen-1")
    expect(defs).toHaveLength(1)
    expect(defs[0].kind).toBe("action.format")
    expect(defs[0].typeVersion).toBe(1)
    expect(defs[0].retryable).toBe(false)
    expect(defs[0].timeoutMs).toBe(5000)

    const result = await defs[0].execute({
      params: { source: "x" },
      upstream: { n1: { out: 1 } },
    } as unknown as StepExecutionContext)

    // The guest dispatches by the UNPREFIXED manifest kind carried in the payload.
    expect(invokeMock).toHaveBeenCalledWith("plugin_wasm_call", {
      pluginId: "demo.wasm",
      generation: "wasm-gen-1",
      exportName: "workflow-node-execute",
      payloadJson: JSON.stringify({
        kind: "action.format",
        params: { source: "x" },
        upstream: { n1: { out: 1 } },
      }),
    })
    expect(result).toEqual({ output: { formatted: "ok" } })
  })

  it("returns an empty list when the manifest declares no workflow nodes", () => {
    expect(buildWasmNodeDefs(baseManifest)).toEqual([])
  })
})

describe("loadWasmDefinition", () => {
  beforeEach(() => setTauri(true))

  it("throws when manifest.wasmMain is missing", async () => {
    const bad: PluginManifest = { ...baseManifest, wasmMain: undefined }
    await expect(loadWasmDefinition(bad, "/plugins/demo")).rejects.toThrow(/wasmMain/)
  })

  it("throws when wasm.apiVersion is missing", async () => {
    const bad: PluginManifest = { ...baseManifest, wasm: undefined }
    await expect(loadWasmDefinition(bad, "/plugins/demo")).rejects.toThrow(/apiVersion/)
  })

  it("invokes plugin_wasm_load with the manifest JSON", async () => {
    invokeMock.mockResolvedValueOnce({ pluginApiVersion: "0.1.0", generation: "wasm-gen-1" })
    const def = await loadWasmDefinition(baseManifest, "/plugins/demo")
    expect(invokeMock).toHaveBeenCalledWith(
      "plugin_wasm_load",
      expect.objectContaining({
        pluginId: "demo.wasm",
        pluginPath: "/plugins/demo",
        manifestJson: expect.any(String),
      })
    )
    const sent = JSON.parse(invokeMock.mock.calls[0][1].manifestJson)
    expect(sent.id).toBe("demo.wasm")
    expect(def.manifest.id).toBe("demo.wasm")
  })

  it("routes a headless load through the installed service transport", async () => {
    setTauri(false)
    ;(globalThis as Record<string, unknown>).__COGNIA_HEADLESS__ = true
    transportCallMock.mockResolvedValueOnce({
      pluginApiVersion: "0.1.0",
      generation: "wasm-gen-1",
    })

    await loadWasmDefinition(baseManifest, "/plugins/demo")

    expect(transportCallMock).toHaveBeenCalledWith(
      "plugin_wasm_load",
      expect.objectContaining({ pluginId: "demo.wasm", pluginPath: "/plugins/demo" })
    )
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it("propagates plugin_wasm_load errors with the plugin id", async () => {
    invokeMock.mockRejectedValueOnce(new Error("compile failed"))
    await expect(loadWasmDefinition(baseManifest, "/p")).rejects.toThrow(
      /Failed to load WASM plugin demo\.wasm: compile failed/
    )
  })

  it("activate hook calls plugin_wasm_activate with config JSON", async () => {
    invokeMock.mockResolvedValueOnce({ pluginApiVersion: "0.1.0", generation: "wasm-gen-1" }) // load
    invokeMock.mockResolvedValueOnce({ exports: ["init"] }) // activate
    const def = await loadWasmDefinition(baseManifest, "/p")
    const fakeCtx = {
      logger: { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() },
      config: { foo: "bar" },
    } as unknown as Parameters<typeof def.activate>[0]
    await def.activate(fakeCtx)
    expect(invokeMock).toHaveBeenLastCalledWith(
      "plugin_wasm_activate",
      expect.objectContaining({ pluginId: "demo.wasm", generation: "wasm-gen-1" })
    )
    const sentCfg = JSON.parse(invokeMock.mock.calls[1][1].configJson)
    expect(sentCfg).toEqual({ foo: "bar" })
  })

  it("returns a stub definition when Tauri is unavailable", async () => {
    setTauri(false)
    const def = await loadWasmDefinition(baseManifest, "/p")
    expect(invokeMock).not.toHaveBeenCalled()
    const ctx = {
      logger: { warn: jest.fn(), info: jest.fn(), debug: jest.fn(), error: jest.fn() },
      config: {},
    } as unknown as Parameters<typeof def.activate>[0]
    await def.activate(ctx)
    expect(ctx.logger.warn).toHaveBeenCalledWith(expect.stringContaining("native Cognia host"))
  })
})

describe("callWasmExport", () => {
  beforeEach(() => setTauri(true))

  it("invokes plugin_wasm_call and parses JSON result", async () => {
    invokeMock.mockResolvedValueOnce(JSON.stringify({ value: 42 }))
    const out = await callWasmExport<{ value: number }>(
      "demo.wasm",
      "tool-execute",
      { x: 1 },
      "wasm-gen-1"
    )
    expect(invokeMock).toHaveBeenCalledWith(
      "plugin_wasm_call",
      expect.objectContaining({
        pluginId: "demo.wasm",
        generation: "wasm-gen-1",
        exportName: "tool-execute",
        payloadJson: JSON.stringify({ x: 1 }),
      })
    )
    expect(out).toEqual({ value: 42 })
  })

  it("throws when Tauri unavailable", async () => {
    setTauri(false)
    await expect(callWasmExport("p", "f", null)).rejects.toThrow(/host unavailable/i)
  })
})

describe("unloadWasmPlugin", () => {
  it("no-ops when Tauri is unavailable", async () => {
    setTauri(false)
    await unloadWasmPlugin("demo.wasm")
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it("invokes plugin_wasm_unload otherwise", async () => {
    setTauri(true)
    invokeMock.mockResolvedValueOnce(true)
    await unloadWasmPlugin("demo.wasm", "wasm-gen-1")
    expect(invokeMock).toHaveBeenCalledWith("plugin_wasm_unload", {
      pluginId: "demo.wasm",
      generation: "wasm-gen-1",
    })
  })

  it("propagates unload errors so lifecycle cleanup remains dirty", async () => {
    setTauri(true)
    invokeMock.mockRejectedValueOnce(new Error("boom"))
    await expect(unloadWasmPlugin("demo.wasm", "wasm-gen-1")).rejects.toThrow("boom")
  })
})
