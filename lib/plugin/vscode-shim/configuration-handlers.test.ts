type Handler = (
  payload: unknown,
  context: { pluginId: string; method: string; requestId: null }
) => unknown
const handlers = new Map<string, Handler>()

jest.mock("./rpc-dispatcher", () => ({
  registerMethod: (method: string, handler: Handler) => {
    handlers.set(method, handler)
    return () => handlers.delete(method)
  },
}))

const mockApply = jest.fn()
jest.mock("@/lib/plugin/core/apply-plugin-config", () => ({
  applyPluginConfig: (...args: unknown[]) => mockApply(...args),
}))

import { usePluginStore } from "@/stores/plugin-runtime"
import type { PluginConfigSchema } from "@/types/plugin/plugin"

import {
  __resetVscodeConfigurationForTesting,
  clearVscodeConfigurationForPlugin,
  configureVscodeConfiguration,
  createVscodeConfigurationDependencies,
  installVscodeConfigurationHandlers,
  pushVscodeConfiguration,
  VSCODE_CORE_DEFAULTS,
  type VscodeConfigurationDependencies,
  type VscodeSettingsPlugin,
} from "./configuration-handlers"

const schemaA: PluginConfigSchema = {
  type: "object",
  properties: {
    "a.mode": { type: "string", enum: ["x", "y"], default: "x" },
    "a.size": { type: "integer", minimum: 1, default: 2 },
  },
}

function setup() {
  let plugins: VscodeSettingsPlugin[] = [
    { id: "ext.a", schema: schemaA, config: { "a.size": 5 } },
    {
      id: "ext.b",
      schema: { type: "object", properties: { "b.on": { type: "boolean", default: true } } },
      config: {},
    },
  ]
  let changed: () => void = () => {}
  const sent: Array<[string, string, Record<string, unknown>]> = []
  const deps: VscodeConfigurationDependencies = {
    plugins: () => plugins,
    subscribe: (listener) => {
      changed = listener
      return () => {}
    },
    apply: jest.fn(async (pluginId: string, config: Record<string, unknown>) => {
      plugins = plugins.map((plugin) => (plugin.id === pluginId ? { ...plugin, config } : plugin))
    }),
    sendToHost: jest.fn(async (pluginId: string, method: string, payload: unknown) => {
      sent.push([pluginId, method, payload as Record<string, unknown>])
      return null
    }),
    hosts: () => ["ext.a", "ext.b"],
  }
  configureVscodeConfiguration(deps)
  const call = (payload: unknown, pluginId = "ext.a") =>
    handlers.get("workspace:configurationUpdate")!(payload, {
      pluginId,
      method: "workspace:configurationUpdate",
      requestId: null,
    })
  return {
    deps,
    sent,
    call,
    setPlugins(next: VscodeSettingsPlugin[]) {
      plugins = next
      changed()
    },
    flush: () => new Promise((resolve) => setTimeout(resolve, 0)),
  }
}

beforeEach(() => {
  handlers.clear()
  mockApply.mockReset()
  __resetVscodeConfigurationForTesting()
  installVscodeConfigurationHandlers()
})

it("gives a host every extension's defaults, the core ones, and the user's values", async () => {
  const h = setup()
  await pushVscodeConfiguration("ext.a")
  expect(h.sent).toHaveLength(1)
  const [pluginId, method, payload] = h.sent[0]
  expect([pluginId, method]).toEqual(["ext.a", "workspace:configurationChanged"])
  expect(payload.changed).toEqual([])
  expect(payload.values).toEqual({ "a.size": 5 })
  expect(payload.defaults).toMatchObject({
    "a.mode": "x",
    "a.size": 2,
    "b.on": true,
    "editor.tabSize": VSCODE_CORE_DEFAULTS["editor.tabSize"],
    "telemetry.telemetryLevel": "off",
  })
})

it("tells hosts that have their settings which keys changed, and stays quiet otherwise", async () => {
  const h = setup()
  await pushVscodeConfiguration("ext.a")
  h.setPlugins([
    { id: "ext.a", schema: schemaA, config: { "a.size": 5, "a.mode": "y" } },
    { id: "ext.b", config: {} },
  ])
  await h.flush()
  // Only ext.a has had its first snapshot; ext.b gets one when it activates.
  expect(h.sent.map(([id]) => id)).toEqual(["ext.a", "ext.a"])
  expect((h.sent[1][2].changed as string[]).sort()).toEqual(["a.mode", "b.on"])
  h.setPlugins([
    { id: "ext.a", schema: schemaA, config: { "a.size": 5, "a.mode": "y" } },
    { id: "ext.b", config: {} },
  ])
  await h.flush()
  expect(h.sent).toHaveLength(2)

  clearVscodeConfigurationForPlugin("ext.a")
  h.setPlugins([{ id: "ext.a", schema: schemaA, config: {} }])
  await h.flush()
  expect(h.sent).toHaveLength(2)
})

it("stores an update with the extension that owns the setting, validated, before answering", async () => {
  const h = setup()
  await pushVscodeConfiguration("ext.a")
  await h.call({ extensionId: "ext.a", key: "a.mode", value: "y", target: 1 })
  expect(h.deps.apply).toHaveBeenCalledWith("ext.a", { "a.size": 5, "a.mode": "y" })
  // The caller's host already has the new value when the update answers.
  expect(h.sent.at(-1)?.[2]).toMatchObject({
    values: { "a.size": 5, "a.mode": "y" },
    changed: ["a.mode"],
  })

  await h.call({ key: "a.size", remove: true })
  expect(h.deps.apply).toHaveBeenLastCalledWith("ext.a", { "a.mode": "y" })

  await expect(h.call({ key: "a.mode", value: "z" })).rejects.toThrow(/Invalid value for a.mode/)
  await expect(h.call({ key: "b.on", value: false })).rejects.toThrow(/belongs to ext.b/)
  await expect(h.call({ key: "", value: 1 })).rejects.toThrow(/needs a key/)
  await expect(h.call({ extensionId: "ext.b", key: "a.mode", value: "y" })).rejects.toThrow(
    /ownership/
  )
})

it("keeps a setting nobody contributes with the extension that writes it", async () => {
  const h = setup()
  await h.call({ key: "editor.formatOnSave", value: true }, "ext.b")
  expect(h.deps.apply).toHaveBeenCalledWith("ext.b", { "editor.formatOnSave": true })
  await expect(h.call({ key: "x.y", value: 1 }, "ext.gone")).rejects.toThrow(
    /not an installed VS Code extension/
  )
})

describe("createVscodeConfigurationDependencies", () => {
  afterEach(() => usePluginStore.setState({ plugins: {} }))

  it("reads VS Code plugins from the plugin store and writes through applyPluginConfig", async () => {
    usePluginStore.setState({
      plugins: {
        "ext.a": {
          manifest: { id: "ext.a", type: "vscode-extension", configSchema: schemaA },
          config: { "a.size": 3 },
        },
        native: { manifest: { id: "native", type: "frontend" }, config: { k: 1 } },
      } as never,
    })
    const deps = createVscodeConfigurationDependencies({ sendToHost: jest.fn(), hosts: () => [] })
    expect(deps.plugins()).toEqual([{ id: "ext.a", schema: schemaA, config: { "a.size": 3 } }])

    const listener = jest.fn()
    const stop = deps.subscribe(listener)
    usePluginStore.setState({ plugins: {} })
    expect(listener).toHaveBeenCalledTimes(1)
    stop()

    await deps.apply("ext.a", { "a.size": 4 })
    expect(mockApply).toHaveBeenCalledWith("ext.a", { "a.size": 4 })
  })
})
