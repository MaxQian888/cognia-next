jest.mock("./StrixPanel", () => ({ StrixPanel: () => null }))
jest.mock("./runtime", () => ({
  setStrixRuntime: jest.fn(),
  clearStrixRuntime: jest.fn(),
  setPendingTarget: jest.fn(),
  abortActiveScan: jest.fn(),
}))
jest.mock("./db", () => ({ markInterruptedRuns: jest.fn().mockResolvedValue([]) }))

import definition from "./index"
import { markInterruptedRuns } from "./db"
import { abortActiveScan, clearStrixRuntime, setPendingTarget, setStrixRuntime } from "./runtime"
import type { PluginContext } from "@cognia/plugin-sdk"
const disposePanel = jest.fn()
const register = jest.fn(() => disposePanel)
const reveal = jest.fn(() => true)

function fakeCtx(over: Partial<PluginContext> = {}): PluginContext {
  return {
    pluginId: "strix-security",
    dexie: {} as never,
    terminal: {} as never,
    ui: { showToast: jest.fn(), showConfirmDialog: jest.fn() } as never,
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

  it("hands the panel the workbench + host-UI APIs", async () => {
    await definition.activate(fakeCtx())
    expect(setStrixRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        contextPanels: expect.objectContaining({ setBadge: expect.any(Function) }),
        ui: expect.objectContaining({ showConfirmDialog: expect.any(Function) }),
      })
    )
  })

  it("reconciles orphaned running rows and mirrors them onto the run journal", async () => {
    const securityScans = { syncExecutionRun: jest.fn(), registerRunController: jest.fn() }
    const orphaned = { runId: "old", status: "cancelled" }
    ;(markInterruptedRuns as jest.Mock).mockResolvedValueOnce([orphaned])

    await definition.activate(fakeCtx({ securityScans } as never))

    expect(markInterruptedRuns).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ cutoff: expect.any(Number) })
    )
    await waitFor(() => expect(securityScans.syncExecutionRun).toHaveBeenCalledWith(orphaned))
  })

  it("reveals the panel when the declared command is dispatched", async () => {
    const hooks = (await definition.activate(fakeCtx())) as unknown as {
      onCommand?: (c: string, a: string[]) => Promise<boolean>
    }
    expect(await hooks?.onCommand?.("not-mine", [])).toBe(false)
    expect(await hooks?.onCommand?.("security", [])).toBe(true)
    expect(reveal).toHaveBeenCalledWith("security", "wide")
  })

  it("stashes `/security <target>` args for the form to consume", async () => {
    const hooks = (await definition.activate(fakeCtx())) as unknown as {
      onCommand?: (c: string, a: string[]) => Promise<boolean>
    }
    await hooks?.onCommand?.("security", ["https://example.com"])
    expect(setPendingTarget).toHaveBeenCalledWith("https://example.com")
    expect(reveal).toHaveBeenCalledWith("security", "wide")
  })

  it("joins multi-word targets and ignores empty args", async () => {
    const hooks = (await definition.activate(fakeCtx())) as unknown as {
      onCommand?: (c: string, a: string[]) => Promise<boolean>
    }
    await hooks?.onCommand?.("security", [])
    expect(setPendingTarget).not.toHaveBeenCalled()

    await hooks?.onCommand?.("security", ["./local", "app"])
    expect(setPendingTarget).toHaveBeenCalledWith("./local app")
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

  it("tears everything down on deactivate, including any in-flight scan", async () => {
    await definition.activate(fakeCtx())
    disposePanel.mockClear()

    await definition.deactivate?.(fakeCtx())
    expect(disposePanel).toHaveBeenCalledTimes(1)
    expect(abortActiveScan).toHaveBeenCalledTimes(1)
    // Command teardown is the manager's job for declared commands.
    expect((definition.manifest as { commands?: unknown[] }).commands).toHaveLength(1)
    expect(clearStrixRuntime).toHaveBeenCalledTimes(1)
  })
})

async function waitFor(fn: () => void, tries = 20): Promise<void> {
  for (let i = 0; i < tries; i++) {
    try {
      fn()
      return
    } catch {
      await new Promise((r) => setTimeout(r, 5))
    }
  }
  fn()
}
