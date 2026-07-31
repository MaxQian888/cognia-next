/** @jest-environment jsdom */

// Tests for `useAnthropicDiscovery` — the desktop-only probe hook added for
// the "reuse existing Claude Code login" flow. The heavier credential hooks
// are exercised through the settings components' tests.

import { act, renderHook, waitFor } from "@testing-library/react"

import { useAnthropicDiscovery } from "./hooks"
import { discoverAnthropicAuth, type DiscoveredAnthropicAuth } from "./discovery"
import { isTauri } from "@/lib/tauri"

jest.mock("@/lib/tauri", () => ({
  ...jest.requireActual("@/lib/tauri"),
  isTauri: jest.fn(() => true),
}))

jest.mock("./discovery", () => ({
  discoverAnthropicAuth: jest.fn(),
}))

jest.mock("../core/transport", () => ({
  anthropicOauthSavePkceResult: jest.fn(),
  getAccount: jest.fn(),
  setActiveAccount: jest.fn(),
}))

jest.mock("../core/hooks", () => ({
  useAccounts: jest.fn(() => ({ activeAccountId: null, reload: jest.fn() })),
}))

jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: jest.fn(() => undefined),
}))

jest.mock("@/lib/db/schema", () => ({
  getDb: jest.fn(),
}))

const discoverMock = discoverAnthropicAuth as jest.Mock
const isTauriMock = isTauri as jest.Mock

function sample(): DiscoveredAnthropicAuth {
  return {
    source: "file",
    credentialsPath: "/home/u/.claude/.credentials.json",
    accessToken: "sk-ant-oat01-test",
    refreshToken: "sk-ant-ort01-test",
    expiresAtMs: 1,
    scopes: [],
  }
}

afterEach(() => {
  jest.clearAllMocks()
  isTauriMock.mockReturnValue(true)
})

describe("useAnthropicDiscovery", () => {
  it("loads the discovered credential on mount", async () => {
    discoverMock.mockResolvedValue(sample())
    const { result } = renderHook(() => useAnthropicDiscovery())
    expect(result.current.loading).toBe(true)
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.discovered?.accessToken).toBe("sk-ant-oat01-test")
    expect(result.current.error).toBeNull()
  })

  it("returns null without probing outside Tauri", async () => {
    isTauriMock.mockReturnValue(false)
    const { result } = renderHook(() => useAnthropicDiscovery())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.discovered).toBeNull()
    expect(discoverMock).not.toHaveBeenCalled()
  })

  it("surfaces probe errors", async () => {
    discoverMock.mockRejectedValue(new Error("keyring read failed"))
    const { result } = renderHook(() => useAnthropicDiscovery())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.error).toBe("keyring read failed")
    expect(result.current.discovered).toBeNull()
  })

  it("reload re-probes and clears a previous error", async () => {
    discoverMock.mockRejectedValueOnce(new Error("boom"))
    const { result } = renderHook(() => useAnthropicDiscovery())
    await waitFor(() => expect(result.current.error).toBe("boom"))

    discoverMock.mockResolvedValue(sample())
    await act(async () => {
      await result.current.reload()
    })
    expect(result.current.error).toBeNull()
    expect(result.current.discovered?.source).toBe("file")
  })

  it("reload outside Tauri clears state without probing", async () => {
    discoverMock.mockResolvedValue(sample())
    const { result } = renderHook(() => useAnthropicDiscovery())
    await waitFor(() => expect(result.current.loading).toBe(false))

    isTauriMock.mockReturnValue(false)
    await act(async () => {
      await result.current.reload()
    })
    expect(result.current.discovered).toBeNull()
    expect(discoverMock).toHaveBeenCalledTimes(1)
  })

  // Reading the EXTERNAL Claude Code CLI keychain item pops a separate macOS
  // keychain prompt. Callers that already hold a credential pass `enabled:
  // false` so that redundant probe (and its prompt) never fires.
  it("does not probe the external keychain when disabled", async () => {
    discoverMock.mockResolvedValue(sample())
    const { result } = renderHook(() => useAnthropicDiscovery({ enabled: false }))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(discoverMock).not.toHaveBeenCalled()
    expect(result.current.discovered).toBeNull()
  })

  it("probes once `enabled` flips from false to true", async () => {
    discoverMock.mockResolvedValue(sample())
    const { result, rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) => useAnthropicDiscovery({ enabled }),
      { initialProps: { enabled: false } }
    )
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(discoverMock).not.toHaveBeenCalled()

    rerender({ enabled: true })
    await waitFor(() => expect(result.current.discovered?.source).toBe("file"))
    expect(discoverMock).toHaveBeenCalledTimes(1)
  })
})
