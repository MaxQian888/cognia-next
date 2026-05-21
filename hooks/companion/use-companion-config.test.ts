/**
 * @jest-environment jsdom
 */
import { act, renderHook, waitFor } from "@testing-library/react"

import type { CompanionConfig, CompanionConfigStorage } from "@/lib/tauri/companion-storage"

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

type ConnectionHandler = (state: string) => void
const connectionHandlers: Set<ConnectionHandler> = new Set()
let resumeHandler: (() => void) | null = null

jest.mock("@/lib/tauri", () => ({
  isTauri: () => false,
  isCapacitor: () => false,
  transport: {
    onConnectionStateChange: (h: ConnectionHandler) => {
      connectionHandlers.add(h)
      return () => connectionHandlers.delete(h)
    },
  },
}))

jest.mock("@/lib/capacitor/app", () => ({
  subscribeResume: async (handler: () => void) => {
    resumeHandler = handler
    return () => {
      if (resumeHandler === handler) resumeHandler = null
    }
  },
}))

import { useCompanionConfig } from "./use-companion-config"

function makeStorage(initial: CompanionConfig | null): CompanionConfigStorage & {
  load: jest.Mock
  set: (next: CompanionConfig | null) => void
} {
  let current: CompanionConfig | null = initial
  const stub: CompanionConfigStorage & {
    load: jest.Mock
    set: (n: CompanionConfig | null) => void
  } = {
    load: jest.fn(async () => current),
    save: jest.fn(async (next: CompanionConfig) => {
      current = next
    }),
    clear: jest.fn(async () => {
      current = null
    }),
    set: (next: CompanionConfig | null) => {
      current = next
    },
  }
  return stub
}

const CONFIG_A: CompanionConfig = {
  baseUrl: "https://example.test:7890",
  deviceJwt: "jwt-a",
  deviceId: "ABCDEFGH1234",
  serverVersion: "0.1.0",
}

beforeEach(() => {
  connectionHandlers.clear()
  resumeHandler = null
})

describe("useCompanionConfig", () => {
  it("hydrates the config on mount", async () => {
    const storage = makeStorage(CONFIG_A)
    const { result } = renderHook(() => useCompanionConfig({ storage }))

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.paired).toBe(true)
    expect(result.current.config?.deviceId).toBe(CONFIG_A.deviceId)
    expect(result.current.shortDeviceId).toBe("ABCDEFGH")
    expect(storage.load).toHaveBeenCalledTimes(1)
  })

  it("reports paired=false + shortDeviceId=null when no config is stored", async () => {
    const storage = makeStorage(null)
    const { result } = renderHook(() => useCompanionConfig({ storage }))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.paired).toBe(false)
    expect(result.current.shortDeviceId).toBeNull()
  })

  it("re-loads when the transport flips to unauthenticated", async () => {
    const storage = makeStorage(CONFIG_A)
    const { result } = renderHook(() => useCompanionConfig({ storage }))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(storage.load).toHaveBeenCalledTimes(1)

    // Desktop revokes the pairing — backend now returns null.
    storage.set(null)
    act(() => {
      for (const h of connectionHandlers) h("unauthenticated")
    })
    await waitFor(() => expect(result.current.paired).toBe(false))
    expect(storage.load).toHaveBeenCalledTimes(2)
  })

  it("re-loads when the app resumes to foreground", async () => {
    const storage = makeStorage(null)
    const { result } = renderHook(() => useCompanionConfig({ storage }))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(storage.load).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(resumeHandler).not.toBeNull())

    storage.set(CONFIG_A)
    act(() => {
      resumeHandler?.()
    })
    await waitFor(() => expect(result.current.paired).toBe(true))
    expect(storage.load).toHaveBeenCalledTimes(2)
  })

  it("manual reload() refreshes the config", async () => {
    const storage = makeStorage(null)
    const { result } = renderHook(() => useCompanionConfig({ storage }))
    await waitFor(() => expect(result.current.loading).toBe(false))
    storage.set(CONFIG_A)
    await act(async () => {
      await result.current.reload()
    })
    expect(result.current.paired).toBe(true)
  })

  it("detaches both subscribers on unmount", async () => {
    const storage = makeStorage(CONFIG_A)
    const { unmount } = renderHook(() => useCompanionConfig({ storage }))
    await waitFor(() => expect(resumeHandler).not.toBeNull())
    expect(connectionHandlers.size).toBe(1)
    unmount()
    expect(connectionHandlers.size).toBe(0)
    expect(resumeHandler).toBeNull()
  })
})
