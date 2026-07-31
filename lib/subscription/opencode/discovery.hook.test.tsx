/**
 * @jest-environment jsdom
 *
 * Covers the `useOpencodeDiscovery` React hook (the pure facade functions
 * are covered in `discovery.test.ts`, which runs in the node environment).
 */
import { act, renderHook, waitFor } from "@testing-library/react"

const isTauriMock = jest.fn()
jest.mock("@/lib/tauri", () => ({
  isTauri: () => isTauriMock(),
  transport: { call: jest.fn() },
}))

const opencodeOauthDiscoverMock = jest.fn()
jest.mock("../core/transport", () => ({
  opencodeOauthDiscover: (...a: unknown[]) => opencodeOauthDiscoverMock(...a),
  opencodeSaveZenKey: jest.fn(),
}))

import { useOpencodeDiscovery } from "./discovery"

const DISCOVERED = {
  authJsonPath: "C:/Users/u/.local/share/opencode/auth.json",
  entries: [{ subProvider: "opencode-go", kind: "api-key", payloadJson: "{}" }],
}

beforeEach(() => {
  jest.clearAllMocks()
  isTauriMock.mockReturnValue(true)
  opencodeOauthDiscoverMock.mockResolvedValue(DISCOVERED)
})

describe("useOpencodeDiscovery", () => {
  it("probes on mount and exposes the result", async () => {
    const { result } = renderHook(() => useOpencodeDiscovery())
    expect(result.current.loading).toBe(true)
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.discovered?.entries[0]?.subProvider).toBe("opencode-go")
    expect(result.current.error).toBeNull()
  })

  it("stays empty outside tauri without probing", async () => {
    isTauriMock.mockReturnValue(false)
    const { result } = renderHook(() => useOpencodeDiscovery())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.discovered).toBeNull()
    expect(opencodeOauthDiscoverMock).not.toHaveBeenCalled()
  })

  it("surfaces a probe error", async () => {
    opencodeOauthDiscoverMock.mockRejectedValue(new Error("ipc down"))
    const { result } = renderHook(() => useOpencodeDiscovery())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.error).toBe("ipc down")
  })

  it("reload re-probes and clears a previous error", async () => {
    opencodeOauthDiscoverMock.mockRejectedValueOnce(new Error("first boom"))
    const { result } = renderHook(() => useOpencodeDiscovery())
    await waitFor(() => expect(result.current.error).toBe("first boom"))

    await act(async () => {
      await result.current.reload()
    })
    expect(result.current.error).toBeNull()
    expect(result.current.discovered?.authJsonPath).toContain("auth.json")
  })

  it("reload outside tauri resets to empty", async () => {
    const { result } = renderHook(() => useOpencodeDiscovery())
    await waitFor(() => expect(result.current.loading).toBe(false))
    isTauriMock.mockReturnValue(false)
    await act(async () => {
      await result.current.reload()
    })
    expect(result.current.discovered).toBeNull()
    expect(result.current.loading).toBe(false)
  })

  it("reload surfaces a fresh error and nulls the data", async () => {
    const { result } = renderHook(() => useOpencodeDiscovery())
    await waitFor(() => expect(result.current.loading).toBe(false))
    opencodeOauthDiscoverMock.mockRejectedValue(new Error("relapse"))
    await act(async () => {
      await result.current.reload()
    })
    expect(result.current.error).toBe("relapse")
    expect(result.current.discovered).toBeNull()
  })
})
