/**
 * Tests for TerminalBootInitializer: on mount (Tauri only) it syncs the
 * terminal profiles to the host, reattaches surviving PTY sessions, and
 * warm-imports the dock-tool-handler.
 */

import { render } from "@testing-library/react"

jest.mock("@/lib/tauri", () => ({ isTauri: jest.fn() }))
// Cheap module to satisfy the warm-import — the real handler depends on
// stores not stood up in this test.
jest.mock("@/lib/terminal/dock-tool-handler", () => ({ runTerminalDockAction: jest.fn() }))
const mockRehydrate = jest.fn(async () => undefined)
jest.mock("@/lib/terminal/rehydrate", () => ({ rehydrateTerminals: () => mockRehydrate() }))
const mockSyncTerminalHostProfiles = jest.fn(async (..._args: unknown[]) => undefined)
jest.mock("@/lib/terminal/host-profiles", () => ({
  syncTerminalHostProfiles: (...args: unknown[]) => mockSyncTerminalHostProfiles(...args),
}))
let mockSettingsLoaded = true
const mockSettingsListeners = new Set<(state: { loaded: boolean }) => void>()
const mockSettingsState = {
  get loaded() {
    return mockSettingsLoaded
  },
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
    subscribe: (listener: (state: { loaded: boolean }) => void) => {
      mockSettingsListeners.add(listener)
      return () => mockSettingsListeners.delete(listener)
    },
  },
}))
const restorePersistedLayout = jest.fn()
jest.mock("@/stores/terminal/terminal-store", () => ({
  useTerminalStore: {
    getState: () => ({ restorePersistedLayout }),
  },
}))

import { isTauri } from "@/lib/tauri"

import { TerminalBootInitializer } from "./terminal-boot-initializer"

const mockedIsTauri = isTauri as jest.MockedFunction<typeof isTauri>

const flush = async () => {
  for (let i = 0; i < 3; i++) await Promise.resolve()
}

beforeEach(() => {
  jest.clearAllMocks()
  mockSettingsLoaded = true
  mockSettingsListeners.clear()
})

describe("TerminalBootInitializer", () => {
  // The component only mounts behind `desktop-only-initializers.tsx`'s own
  // `isTauri()` gate, so this is the local guard, not the shell's story. Web
  // and Capacitor reattach through `lib/terminal/boot-reattach.ts` instead —
  // this initializer must not also touch the layout there, or the two would
  // race to validate tab metadata against different session maps.
  it("does nothing outside Tauri, and leaves the layout to boot-reattach", async () => {
    mockedIsTauri.mockReturnValue(false)
    const { unmount } = render(<TerminalBootInitializer />)
    unmount()
    await flush()
    expect(mockSyncTerminalHostProfiles).not.toHaveBeenCalled()
    expect(mockRehydrate).not.toHaveBeenCalled()
    expect(restorePersistedLayout).not.toHaveBeenCalled()
  })

  it("syncs the terminal profiles and reattaches surviving sessions in Tauri", async () => {
    mockedIsTauri.mockReturnValue(true)
    render(<TerminalBootInitializer />)
    await flush()
    expect(mockSyncTerminalHostProfiles).toHaveBeenCalledWith(
      mockSettingsState.settings.terminal.profiles,
      expect.objectContaining({ sandboxed: true })
    )
    expect(mockRehydrate).toHaveBeenCalledTimes(1)
    expect(restorePersistedLayout).not.toHaveBeenCalled()
  })

  it("waits for the settings to load before syncing the profiles", async () => {
    mockedIsTauri.mockReturnValue(true)
    mockSettingsLoaded = false
    const { unmount } = render(<TerminalBootInitializer />)
    expect(mockSyncTerminalHostProfiles).not.toHaveBeenCalled()
    mockSettingsLoaded = true
    mockSettingsListeners.forEach((listener) => listener({ loaded: true }))
    expect(mockSyncTerminalHostProfiles).toHaveBeenCalledTimes(1)
    unmount()
    expect(mockSettingsListeners.size).toBe(0)
  })

  it("warm-imports the dock-tool-handler so the first agent call doesn't pay an import roundtrip", async () => {
    mockedIsTauri.mockReturnValue(true)
    render(<TerminalBootInitializer />)
    await flush()
    const mod = await import("@/lib/terminal/dock-tool-handler")
    expect(typeof mod.runTerminalDockAction).toBe("function")
  })
})
