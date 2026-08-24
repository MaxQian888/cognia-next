import type { PluginContext } from "@/types/plugin"

jest.mock("@/lib/sandbox/microvm-bridge", () => ({ setMicrovmExec: jest.fn() }))

const fakeBackend = { kind: "e2b-backend" }
jest.mock("./workspace-backend", () => ({
  E2BWorkspaceBackend: jest.fn(() => fakeBackend),
}))

const fakeExec = { kind: "microvm-exec", dispose: jest.fn(async () => undefined) }
jest.mock("./microvm-exec", () => ({ buildMicrovmExec: jest.fn(() => fakeExec) }))

import { setMicrovmExec } from "@/lib/sandbox/microvm-bridge"
import { E2BWorkspaceBackend } from "./workspace-backend"
import { buildMicrovmExec } from "./microvm-exec"
import e2bSandbox from "./index"

const setMicrovmExecMock = setMicrovmExec as jest.Mock
const E2BWorkspaceBackendMock = E2BWorkspaceBackend as jest.Mock
const buildMicrovmExecMock = buildMicrovmExec as jest.Mock

function makeCtx(opts: { workspace?: boolean; config?: Record<string, unknown> } = {}) {
  const presets: Array<{ id: string }> = []
  const unregister = jest.fn()
  const registerBackend = jest.fn(() => ({ unregister }))
  const showToast = jest.fn()
  const config = opts.config ?? {}
  const configUnsubscribe = jest.fn()
  const ctx: Partial<PluginContext> = {
    pluginId: "cognia-e2b-sandbox",
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } as never,
    config,
    configuration: {
      getAll: () => config,
      onChange: (_listener: (next: Record<string, unknown>) => void) => {
        return configUnsubscribe
      },
    } as never,
    agent: {
      registerMcpServerPreset: (preset: { id: string }) => {
        presets.push(preset)
      },
    } as never,
    ui: { showToast } as never,
    workspace: opts.workspace ? ({ registerBackend } as never) : undefined,
  }
  return {
    ctx: ctx as PluginContext,
    presets,
    registerBackend,
    unregister,
    showToast,
    configUnsubscribe,
  }
}

beforeEach(() => {
  setMicrovmExecMock.mockReset()
  E2BWorkspaceBackendMock.mockClear()
  buildMicrovmExecMock.mockClear()
  fakeExec.dispose.mockClear()
})

describe("e2b-sandbox (built-in)", () => {
  it("declares plugin config and exposes AgentENV's API URL in the MCP preset", () => {
    const manifest = e2bSandbox.manifest as unknown as {
      capabilities: string[]
      activationEvents: string[]
      commands: Array<{ id: string; name: string }>
      configSchema?: { properties?: Record<string, unknown> }
      mcpServerPresets: Array<{
        id: string
        config: { env?: Record<string, string> }
        fields: Array<{ key: string; placement: string; secret?: boolean }>
      }>
    }
    expect(manifest.capabilities).toContain("configuration")
    expect(manifest.activationEvents).toContain("onCommand:sandbox")
    expect(manifest.commands).toContainEqual(expect.objectContaining({ id: "sandbox" }))
    expect(manifest.configSchema?.properties).toHaveProperty("apiUrl")
    const preset = manifest.mcpServerPresets[0]
    expect(preset.id).toBe("e2b-sandbox")
    expect(preset.config.env).toHaveProperty("E2B_API_URL")
    const byKey = Object.fromEntries(preset.fields.map((f) => [f.key, f]))
    expect(byKey.E2B_API_KEY).toMatchObject({ placement: "env", secret: true })
    expect(byKey.E2B_API_URL).toMatchObject({ placement: "env" })
  })

  it("activate registers the e2b MCP preset and handles the managed /sandbox command", async () => {
    const { ctx, presets, showToast } = makeCtx({ workspace: true })
    const hooks = await e2bSandbox.activate?.(ctx)
    expect(presets).toEqual([expect.objectContaining({ id: "e2b-sandbox" })])
    await expect(hooks?.onCommand?.("sandbox", [])).resolves.toBe(true)
    expect(showToast).toHaveBeenCalledWith(
      expect.stringContaining("Settings → Plugins → E2B Sandbox"),
      "info"
    )
    expect(showToast).toHaveBeenCalledWith(
      expect.stringContaining("Settings → MCP Servers"),
      "info"
    )
    await expect(hooks?.onCommand?.("other", [])).resolves.toBe(false)
    await e2bSandbox.deactivate?.(ctx)
  })

  it("registers through ctx.workspace.registerBackend and tears down via its disposer", async () => {
    const { ctx, registerBackend, unregister } = makeCtx({ workspace: true })
    await e2bSandbox.activate?.(ctx)
    expect(registerBackend).toHaveBeenCalledWith(
      expect.objectContaining({ id: "e2b", backend: fakeBackend })
    )
    await e2bSandbox.deactivate?.(ctx)
    expect(unregister).toHaveBeenCalledTimes(1)
  })

  it("fails loudly when the host context has no workspace API (no legacy shim fallback)", async () => {
    const { ctx } = makeCtx({ workspace: false })
    await expect(e2bSandbox.activate?.(ctx)).rejects.toThrow(/no `workspace` API/)
    expect(E2BWorkspaceBackendMock).not.toHaveBeenCalled()
  })

  it("wires the microvm exec adapter on activate and clears it on deactivate", async () => {
    const { ctx } = makeCtx({ workspace: true })
    await e2bSandbox.activate?.(ctx)
    expect(setMicrovmExecMock).toHaveBeenCalledWith(fakeExec)
    await e2bSandbox.deactivate?.(ctx)
    expect(setMicrovmExecMock).toHaveBeenLastCalledWith(null)
  })

  it("does not close live workspaces on deactivate", async () => {
    const { ctx } = makeCtx({ workspace: true })
    await e2bSandbox.activate?.(ctx)
    await e2bSandbox.deactivate?.(ctx)

    // `dispose()` closes every entry in the shared pool — including the
    // workspaces `E2BWorkspaceBackend.clone` handed to Agent Team teammates who
    // are still working inside them. Toggling the plugin off must not destroy
    // in-flight runs; those workspaces belong to the handles that were issued
    // and are reaped by `remove(handle)`.
    expect(fakeExec.dispose).not.toHaveBeenCalled()
  })

  it("deactivate unsubscribes from plugin config changes", async () => {
    const { ctx, configUnsubscribe } = makeCtx({ workspace: true })
    await e2bSandbox.activate?.(ctx)
    await e2bSandbox.deactivate?.(ctx)
    expect(configUnsubscribe).toHaveBeenCalledTimes(1)
  })
})
