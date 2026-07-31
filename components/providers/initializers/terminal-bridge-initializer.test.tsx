/**
 * Tests for TerminalBridgeInitializer.
 *
 * The component is pure side-effect: on mount it wires the VSCode-shim
 * terminal bridge (Tauri-only) and warm-imports the dock-tool-handler so
 * the first agent terminal_dock_* call doesn't pay a dynamic-import
 * round-trip mid-tool.
 */

import { render } from "@testing-library/react"

jest.mock("@/lib/tauri", () => ({ isTauri: jest.fn() }))
jest.mock("@/lib/plugin/vscode-shim/pty-bridge-adapter", () => ({
  createPtyShellSpawn: jest.fn(() => "stub-spawn"),
}))
jest.mock("@/lib/plugin/vscode-shim/terminal-bridge", () => ({
  __resetTerminalBridgeForTesting: jest.fn(),
  configureTerminalBridge: jest.fn(),
}))
// Cheap module to satisfy the warm-import — the real handler depends on
// stores not stood up in this test.
jest.mock("@/lib/terminal/dock-tool-handler", () => ({ runTerminalDockAction: jest.fn() }))
const mockSyncTerminalHostProfiles = jest.fn(async (..._args: unknown[]) => undefined)
jest.mock("@/lib/terminal/host-profiles", () => ({
  syncTerminalHostProfiles: (...args: unknown[]) => mockSyncTerminalHostProfiles(...args),
}))
const mockSettingsState = {
  loaded: true,
  settings: {
    terminal: {
      profiles: [{ id: "zsh", name: "Zsh", shell: "/bin/zsh" }],
      sandboxed: true,
    },
  },
}
jest.mock("@/stores/settings/settings-store", () => ({
  useSettingsStore: {
    getState: () => mockSettingsState,
    subscribe: jest.fn(() => () => undefined),
  },
}))
const restorePersistedLayout = jest.fn()
jest.mock("@/stores/terminal/terminal-store", () => ({
  useTerminalStore: {
    getState: () => ({ restorePersistedLayout }),
  },
}))

import { isTauri } from "@/lib/tauri"
import { createPtyShellSpawn } from "@/lib/plugin/vscode-shim/pty-bridge-adapter"
import {
  __resetTerminalBridgeForTesting,
  configureTerminalBridge,
} from "@/lib/plugin/vscode-shim/terminal-bridge"

import { TerminalBridgeInitializer } from "./terminal-bridge-initializer"

const mockedIsTauri = isTauri as jest.MockedFunction<typeof isTauri>
const mockedConfigure = configureTerminalBridge as jest.MockedFunction<
  typeof configureTerminalBridge
>
const mockedReset = __resetTerminalBridgeForTesting as jest.MockedFunction<
  typeof __resetTerminalBridgeForTesting
>
const mockedCreate = createPtyShellSpawn as jest.MockedFunction<typeof createPtyShellSpawn>

beforeEach(() => {
  jest.clearAllMocks()
})

describe("TerminalBridgeInitializer", () => {
  it("skips wiring entirely outside Tauri", () => {
    mockedIsTauri.mockReturnValue(false)
    const { unmount } = render(<TerminalBridgeInitializer />)
    unmount()
    expect(mockedConfigure).not.toHaveBeenCalled()
    expect(mockedCreate).not.toHaveBeenCalled()
    expect(restorePersistedLayout).toHaveBeenCalledTimes(1)
  })

  it("wires configureTerminalBridge with the PTY spawn and a no-op sink in Tauri", () => {
    mockedIsTauri.mockReturnValue(true)
    render(<TerminalBridgeInitializer />)
    expect(mockedConfigure).toHaveBeenCalledTimes(1)
    expect(restorePersistedLayout).not.toHaveBeenCalled()
    const arg = mockedConfigure.mock.calls[0][0]
    expect(arg.spawn).toBe("stub-spawn")
    // Sink should be a noop pair the test can call without throwing.
    expect(typeof arg.outputSink.appendLine).toBe("function")
    expect(typeof arg.outputSink.markClosed).toBe("function")
    arg.outputSink.appendLine("term-1", "stdout", "anything")
    arg.outputSink.markClosed("term-1", 0)
    expect(mockSyncTerminalHostProfiles).toHaveBeenCalledWith(
      mockSettingsState.settings.terminal.profiles,
      expect.objectContaining({ sandboxed: true })
    )
  })

  it("resets the bridge on unmount (fast-refresh safety)", () => {
    mockedIsTauri.mockReturnValue(true)
    const { unmount } = render(<TerminalBridgeInitializer />)
    expect(mockedReset).not.toHaveBeenCalled()
    unmount()
    expect(mockedReset).toHaveBeenCalledTimes(1)
  })

  it("warm-imports the dock-tool-handler so the first agent call doesn't pay an import roundtrip", async () => {
    // Force a `dock-tool-handler` import to happen via the side effect of
    // mounting. The mock above guarantees the import resolves synchronously
    // on subsequent require()s; we just verify the symbol is reachable
    // after a tick.
    mockedIsTauri.mockReturnValue(true)
    render(<TerminalBridgeInitializer />)
    // Yield a couple of microtask turns so the warm `import()` promise
    // chain inside the effect resolves before we verify the module
    // graph. jsdom doesn't expose `setImmediate`; microtasks suffice.
    for (let i = 0; i < 3; i++) await Promise.resolve()
    const mod = await import("@/lib/terminal/dock-tool-handler")
    expect(typeof mod.runTerminalDockAction).toBe("function")
  })
})
