import type { PluginContext } from "@/types/plugin"

jest.mock("@/lib/slash-commands/registry", () => ({
  registerSlashCommand: jest.fn(),
  unregisterCommandsByPlugin: jest.fn(),
}))

jest.mock("@/lib/github/workspace", () => ({ setE2BBackend: jest.fn() }))
jest.mock("@/lib/sandbox/microvm-bridge", () => ({ setMicrovmExec: jest.fn() }))

const fakeBackend = { kind: "e2b-backend" }
jest.mock("./workspace-backend", () => ({
  E2BWorkspaceBackend: jest.fn(() => fakeBackend),
}))

const fakeExec = { kind: "microvm-exec" }
jest.mock("./microvm-exec", () => ({ buildMicrovmExec: jest.fn(() => fakeExec) }))

import { registerSlashCommand, unregisterCommandsByPlugin } from "@/lib/slash-commands/registry"
import { setE2BBackend } from "@/lib/github/workspace"
import { setMicrovmExec } from "@/lib/sandbox/microvm-bridge"
import { E2BWorkspaceBackend } from "./workspace-backend"
import { buildMicrovmExec } from "./microvm-exec"
import e2bSandbox from "./index"

const registerMock = registerSlashCommand as jest.Mock
const unregisterMock = unregisterCommandsByPlugin as jest.Mock
const setE2BBackendMock = setE2BBackend as jest.Mock
const setMicrovmExecMock = setMicrovmExec as jest.Mock
const E2BWorkspaceBackendMock = E2BWorkspaceBackend as jest.Mock
const buildMicrovmExecMock = buildMicrovmExec as jest.Mock

function makeCtx(opts: { workspace?: boolean; config?: Record<string, unknown> } = {}) {
  const presets: Array<{ id: string }> = []
  const unregister = jest.fn()
  const registerBackend = jest.fn(() => ({ unregister }))
  let config = opts.config ?? {}
  let configListener: ((next: Record<string, unknown>) => void) | undefined
  const configUnsubscribe = jest.fn(() => {
    configListener = undefined
  })
  const ctx: Partial<PluginContext> = {
    pluginId: "cognia-e2b-sandbox",
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } as never,
    config,
    configuration: {
      getAll: () => config,
      onChange: (listener: (next: Record<string, unknown>) => void) => {
        configListener = listener
        return configUnsubscribe
      },
    } as never,
    agent: {
      registerMcpServerPreset: (preset: { id: string }) => {
        presets.push(preset)
      },
    } as never,
    workspace: opts.workspace ? ({ registerBackend } as never) : undefined,
  }
  return {
    ctx: ctx as PluginContext,
    presets,
    registerBackend,
    unregister,
    configUnsubscribe,
    emitConfigChange: (next: Record<string, unknown>) => {
      config = next
      configListener?.(next)
    },
  }
}

beforeEach(() => {
  registerMock.mockReset()
  unregisterMock.mockReset()
  setE2BBackendMock.mockReset()
  setMicrovmExecMock.mockReset()
  E2BWorkspaceBackendMock.mockClear()
  buildMicrovmExecMock.mockClear()
})

describe("e2b-sandbox (built-in)", () => {
  it("declares plugin config and exposes AgentENV's API URL in the MCP preset", () => {
    const manifest = e2bSandbox.manifest as unknown as {
      capabilities: string[]
      configSchema?: { properties?: Record<string, unknown> }
      mcpServerPresets: Array<{
        id: string
        config: { env?: Record<string, string> }
        fields: Array<{ key: string; placement: string; secret?: boolean }>
      }>
    }
    expect(manifest.capabilities).toContain("configuration")
    expect(manifest.configSchema?.properties).toHaveProperty("apiUrl")
    const preset = manifest.mcpServerPresets[0]
    expect(preset.id).toBe("e2b-sandbox")
    expect(preset.config.env).toHaveProperty("E2B_API_URL")
    const byKey = Object.fromEntries(preset.fields.map((f) => [f.key, f]))
    expect(byKey.E2B_API_KEY).toMatchObject({ placement: "env", secret: true })
    expect(byKey.E2B_API_URL).toMatchObject({ placement: "env" })
  })

  it("activate registers the e2b MCP preset and the /sandbox slash command", async () => {
    const { ctx, presets } = makeCtx({ workspace: true })
    await e2bSandbox.activate?.(ctx)
    expect(presets).toEqual([expect.objectContaining({ id: "e2b-sandbox" })])
    expect(registerMock).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "e2b.attach",
        name: "/sandbox",
        source: "plugin",
        pluginId: "cognia-e2b-sandbox",
      })
    )
    await e2bSandbox.deactivate?.(ctx)
  })

  it("prefers ctx.workspace.registerBackend and tears down via its disposer", async () => {
    const { ctx, registerBackend, unregister } = makeCtx({ workspace: true })
    await e2bSandbox.activate?.(ctx)
    expect(registerBackend).toHaveBeenCalledWith(
      expect.objectContaining({ id: "e2b", backend: fakeBackend })
    )
    expect(setE2BBackendMock).not.toHaveBeenCalled()
    await e2bSandbox.deactivate?.(ctx)
    expect(unregister).toHaveBeenCalledTimes(1)
    expect(setE2BBackendMock).not.toHaveBeenCalled()
  })

  it("falls back to the legacy setE2BBackend shim when ctx.workspace is absent", async () => {
    const { ctx } = makeCtx({ workspace: false })
    await e2bSandbox.activate?.(ctx)
    expect(setE2BBackendMock).toHaveBeenCalledWith(fakeBackend)
    await e2bSandbox.deactivate?.(ctx)
    expect(setE2BBackendMock).toHaveBeenLastCalledWith(null)
  })

  it("wires the microvm exec adapter on activate and clears it on deactivate", async () => {
    const { ctx } = makeCtx({ workspace: true })
    await e2bSandbox.activate?.(ctx)
    expect(setMicrovmExecMock).toHaveBeenCalledWith(fakeExec)
    await e2bSandbox.deactivate?.(ctx)
    expect(setMicrovmExecMock).toHaveBeenLastCalledWith(null)
  })

  it("threads plugin config into the SDK connection resolver and tracks config changes", async () => {
    const { ctx, emitConfigChange } = makeCtx({
      workspace: true,
      config: { apiKey: "key-1", apiUrl: "http://127.0.0.1:8000" },
    })
    await e2bSandbox.activate?.(ctx)
    const backendOptions = E2BWorkspaceBackendMock.mock.calls[0][0] as {
      connection: () => unknown
    }
    const execOptions = buildMicrovmExecMock.mock.calls[0][0] as { connection: () => unknown }
    expect(backendOptions.connection()).toEqual({
      apiKey: "key-1",
      domain: "http://127.0.0.1:8000",
    })
    expect(execOptions.connection()).toEqual({
      apiKey: "key-1",
      domain: "http://127.0.0.1:8000",
    })

    emitConfigChange({ apiKey: "key-2", apiUrl: "http://agentenv.local:8000" })
    expect(backendOptions.connection()).toEqual({
      apiKey: "key-2",
      domain: "http://agentenv.local:8000",
    })
    await e2bSandbox.deactivate?.(ctx)
  })

  it("deactivate unregisters the plugin's commands", async () => {
    const { ctx } = makeCtx({ workspace: true })
    await e2bSandbox.activate?.(ctx)
    await e2bSandbox.deactivate?.(ctx)
    expect(unregisterMock).toHaveBeenCalledWith("cognia-e2b-sandbox")
  })

  it("deactivate unsubscribes from plugin config changes", async () => {
    const { ctx, configUnsubscribe } = makeCtx({ workspace: true })
    await e2bSandbox.activate?.(ctx)
    await e2bSandbox.deactivate?.(ctx)
    expect(configUnsubscribe).toHaveBeenCalledTimes(1)
  })
})
