jest.mock("./StrixPanel", () => ({ StrixPanel: () => null }))
jest.mock("./runtime", () => ({ setStrixRuntime: jest.fn(), clearStrixRuntime: jest.fn() }))

import definition from "./index"
import { clearStrixRuntime, setStrixRuntime } from "./runtime"
import type { PluginContext } from "@cognia/plugin-sdk"
const disposePanel = jest.fn()
const register = jest.fn(() => disposePanel)
const reveal = jest.fn(() => true)

function fakeCtx(over: Partial<PluginContext> = {}): PluginContext {
  return {
    pluginId: "strix-security",
    dexie: {} as never,
    terminal: {} as never,
    securityScans: { syncExecutionRun: jest.fn(), registerRunController: jest.fn() } as never,
    contextPanels: { register, reveal, setBadge: jest.fn() },
    logger: { info: jest.fn(), error: jest.fn() },
    ...over,
  } as unknown as PluginContext
}

beforeEach(() => jest.clearAllMocks())

describe("strix-security plugin lifecycle", () => {
  it("registers the panel in the right-hand workbench, not a left rail container", async () => {
    await definition.activate(fakeCtx())

    expect(setStrixRuntime).toHaveBeenCalledTimes(1)
    expect(register).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "security",
        activity: "review",
        resourceKinds: ["session"],
        preferredMode: "wide",
        retention: "stateful",
      })
    )
    // The slash command is DECLARED (manifest.commands[]) and handled by the
    // hook returned from activate — the plugin must not touch the registry.
    expect((definition.manifest as { commands?: unknown[] }).commands).toHaveLength(1)
  })

  it("hands the panel the workbench API so a running scan can badge its own button", async () => {
    await definition.activate(fakeCtx())
    expect(setStrixRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        contextPanels: expect.objectContaining({ setBadge: expect.any(Function) }),
      })
    )
  })

  it("reveals the panel when the declared command is dispatched", async () => {
    const hooks = (await definition.activate(fakeCtx())) as unknown as {
      onCommand?: (c: string, a: string[]) => Promise<boolean>
    }
    expect(await hooks?.onCommand?.("not-mine", [])).toBe(false)
    expect(await hooks?.onCommand?.("security", [])).toBe(true)
    expect(reveal).toHaveBeenCalledWith("security", "wide")
  })

  it("reports the command unhandled when the shell has no workbench to reveal into", async () => {
    const hooks = (await definition.activate(
      fakeCtx({ contextPanels: undefined } as never)
    )) as unknown as { onCommand?: (c: string, a: string[]) => Promise<boolean> }
    expect(await hooks?.onCommand?.("security", [])).toBe(false)
  })

  it("still registers the panel but logs when dexie is unavailable", async () => {
    const logger = { info: jest.fn(), error: jest.fn() }
    await definition.activate(fakeCtx({ dexie: undefined, logger } as never))
    expect(setStrixRuntime).not.toHaveBeenCalled()
    expect(logger.error).toHaveBeenCalled()
    expect(register).toHaveBeenCalled()
  })

  it("keeps the tools working when the panel registration is refused", async () => {
    const logger = { info: jest.fn(), error: jest.fn() }
    register.mockImplementationOnce(() => {
      throw new Error("Permission denied: extension:ui is required to register a context panel")
    })
    await expect(definition.activate(fakeCtx({ logger } as never))).resolves.toBeDefined()
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("extension:ui"))
  })

  // `disposePanel` is module state in index.ts and survives between tests, so
  // both of these clear the mock AFTER the setup activate — otherwise they
  // count a teardown that belongs to whatever ran before them.
  it("disposes the previous registration when reactivated", async () => {
    await definition.activate(fakeCtx())
    disposePanel.mockClear()
    register.mockClear()

    await definition.activate(fakeCtx())
    expect(disposePanel).toHaveBeenCalledTimes(1)
    expect(register).toHaveBeenCalledTimes(1)
  })

  it("tears everything down on deactivate", async () => {
    await definition.activate(fakeCtx())
    disposePanel.mockClear()

    await definition.deactivate?.(fakeCtx())
    expect(disposePanel).toHaveBeenCalledTimes(1)
    // Command teardown is the manager's job for declared commands.
    expect((definition.manifest as { commands?: unknown[] }).commands).toHaveLength(1)
    expect(clearStrixRuntime).toHaveBeenCalledTimes(1)
  })
})
