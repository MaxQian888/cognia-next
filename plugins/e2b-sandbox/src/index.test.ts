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
import e2bSandbox from "./index"

const registerMock = registerSlashCommand as jest.Mock
const unregisterMock = unregisterCommandsByPlugin as jest.Mock
const setE2BBackendMock = setE2BBackend as jest.Mock
const setMicrovmExecMock = setMicrovmExec as jest.Mock

function makeCtx(opts: { workspace?: boolean } = {}) {
  const presets: Array<{ id: string }> = []
  const unregister = jest.fn()
  const registerBackend = jest.fn(() => ({ unregister }))
  const ctx: Partial<PluginContext> = {
    pluginId: "cognia-e2b-sandbox",
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } as never,
    agent: {
      registerMcpServerPreset: (preset: { id: string }) => {
        presets.push(preset)
      },
    } as never,
    workspace: opts.workspace ? ({ registerBackend } as never) : undefined,
  }
  return { ctx: ctx as PluginContext, presets, registerBackend, unregister }
}

beforeEach(() => {
  registerMock.mockReset()
  unregisterMock.mockReset()
  setE2BBackendMock.mockReset()
  setMicrovmExecMock.mockReset()
})

describe("e2b-sandbox (built-in)", () => {
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

  it("deactivate unregisters the plugin's commands", async () => {
    const { ctx } = makeCtx({ workspace: true })
    await e2bSandbox.activate?.(ctx)
    await e2bSandbox.deactivate?.(ctx)
    expect(unregisterMock).toHaveBeenCalledWith("cognia-e2b-sandbox")
  })
})
