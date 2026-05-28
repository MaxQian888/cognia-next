/**
 * @jest-environment jsdom
 */

import { act, renderHook } from "@testing-library/react"

jest.mock("@/lib/cli-bridge/detect-cli", () => ({
  detectCli: jest.fn(),
}))
jest.mock("@/lib/cli-bridge/status", () => ({
  getCliBridgeStatus: jest.fn(),
}))
jest.mock("@/lib/tauri", () => ({
  isTauri: jest.fn(() => true),
}))

import { detectCli } from "@/lib/cli-bridge/detect-cli"
import { getCliBridgeStatus } from "@/lib/cli-bridge/status"
import { isTauri } from "@/lib/tauri"
import { useCogniaCliStatus } from "./use-cognia-cli-status"

const mockDetect = detectCli as jest.MockedFunction<typeof detectCli>
const mockBridge = getCliBridgeStatus as jest.MockedFunction<typeof getCliBridgeStatus>
const mockIsTauri = isTauri as jest.MockedFunction<typeof isTauri>

async function flush() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

beforeEach(() => {
  mockDetect.mockReset()
  mockBridge.mockReset()
  mockIsTauri.mockReset()
  mockIsTauri.mockReturnValue(true)
  mockBridge.mockResolvedValue({ running: true, boundPort: 1234, endpointFile: "/x" })
})

describe("useCogniaCliStatus", () => {
  it("reports installed + version when the probe succeeds", async () => {
    mockDetect.mockResolvedValue({
      available: true,
      version: "cognia 0.1.0",
      path: "/usr/local/bin/cognia",
      error: null,
    })
    const { result } = renderHook(() => useCogniaCliStatus())
    await flush()
    expect(result.current.installed).toBe(true)
    expect(result.current.version).toBe("cognia 0.1.0")
    expect(result.current.path).toBe("/usr/local/bin/cognia")
    expect(result.current.bridge?.running).toBe(true)
    expect(result.current.loading).toBe(false)
  })

  it("reports not-installed when the probe fails", async () => {
    mockDetect.mockResolvedValue({
      available: false,
      version: null,
      path: null,
      error: "not found",
    })
    const { result } = renderHook(() => useCogniaCliStatus())
    await flush()
    expect(result.current.installed).toBe(false)
    expect(result.current.version).toBeNull()
  })

  it("marks unsupported and skips probing on web", async () => {
    mockIsTauri.mockReturnValue(false)
    const { result } = renderHook(() => useCogniaCliStatus())
    await flush()
    expect(result.current.supported).toBe(false)
    expect(result.current.loading).toBe(false)
    expect(mockDetect).not.toHaveBeenCalled()
  })

  it("re-probes on refresh()", async () => {
    mockDetect.mockResolvedValue({
      available: false,
      version: null,
      path: null,
      error: "not found",
    })
    const { result } = renderHook(() => useCogniaCliStatus())
    await flush()
    expect(mockDetect).toHaveBeenCalledTimes(1)
    mockDetect.mockResolvedValue({
      available: true,
      version: "cognia 0.2.0",
      path: "/x",
      error: null,
    })
    await act(async () => {
      result.current.refresh()
      await Promise.resolve()
    })
    await flush()
    expect(mockDetect).toHaveBeenCalledTimes(2)
    expect(result.current.installed).toBe(true)
  })
})
