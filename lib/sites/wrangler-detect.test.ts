jest.mock("@tauri-apps/api/core", () => ({ invoke: jest.fn() }))
jest.mock("@/lib/cli-bridge/detect-cli", () => ({ detectCli: jest.fn() }))
jest.mock("@/lib/tauri", () => ({ isTauri: jest.fn(() => true) }))
jest.mock("@/lib/sites/approved-tool", () => ({ approveSiteProviderTool: jest.fn() }))

import { invoke } from "@tauri-apps/api/core"
import { detectCli, type BinaryDetectionResult } from "@/lib/cli-bridge/detect-cli"
import { isTauri } from "@/lib/tauri"
import { approveSiteProviderTool } from "@/lib/sites/approved-tool"
import {
  detectWranglerBinary,
  ensureWranglerApproved,
  redetectWranglerBinary,
  toWranglerDetection,
} from "./wrangler-detect"

const detectCliMock = detectCli as jest.Mock
const invokeMock = invoke as jest.Mock
const isTauriMock = isTauri as jest.Mock
const approveMock = approveSiteProviderTool as jest.Mock

function result(overrides: Partial<BinaryDetectionResult> = {}): BinaryDetectionResult {
  return {
    available: true,
    version: "wrangler 3.90.0",
    path: "/usr/local/bin/wrangler",
    error: null,
    ...overrides,
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  isTauriMock.mockReturnValue(true)
})

describe("toWranglerDetection", () => {
  it("marks ready when available with a resolved absolute path", () => {
    expect(toWranglerDetection(result())).toEqual({
      path: "/usr/local/bin/wrangler",
      version: "wrangler 3.90.0",
      ready: true,
    })
  })

  it("is not ready when available but the path did not resolve", () => {
    expect(toWranglerDetection(result({ path: null }))).toEqual({
      path: null,
      version: "wrangler 3.90.0",
      ready: false,
    })
  })

  it("is not ready when the binary is unavailable", () => {
    const detection = toWranglerDetection(result({ available: false, path: null, version: null }))
    expect(detection.ready).toBe(false)
    expect(detection.path).toBeNull()
  })
})

describe("detectWranglerBinary", () => {
  it("probes the wrangler binary through detectCli", async () => {
    detectCliMock.mockResolvedValue(result())
    await expect(detectWranglerBinary()).resolves.toEqual({
      path: "/usr/local/bin/wrangler",
      version: "wrangler 3.90.0",
      ready: true,
    })
    expect(detectCliMock).toHaveBeenCalledWith("wrangler")
  })
})

describe("ensureWranglerApproved", () => {
  it("approves the detected absolute path and returns the detection", async () => {
    const detection = { path: "/opt/wrangler", version: "wrangler 3.90.0", ready: true }
    const detect = jest.fn().mockResolvedValue(detection)
    await expect(ensureWranglerApproved(detect)).resolves.toEqual(detection)
    expect(approveMock).toHaveBeenCalledWith("/opt/wrangler")
  })

  it("returns the not-found detection without approving when unresolvable", async () => {
    const detection = { path: null, version: null, ready: false }
    const detect = jest.fn().mockResolvedValue(detection)
    await expect(ensureWranglerApproved(detect)).resolves.toEqual(detection)
    expect(approveMock).not.toHaveBeenCalled()
  })

  it("propagates approval failures instead of swallowing them", async () => {
    const detect = jest.fn().mockResolvedValue({
      path: "/opt/wrangler",
      version: null,
      ready: true,
    })
    approveMock.mockRejectedValue(new Error("bytes changed"))
    await expect(ensureWranglerApproved(detect)).rejects.toThrow("bytes changed")
  })

  it("defaults to the real detector via detectCli", async () => {
    approveMock.mockResolvedValue(undefined)
    detectCliMock.mockResolvedValue(result({ path: "/usr/bin/wrangler" }))
    await expect(ensureWranglerApproved()).resolves.toMatchObject({
      path: "/usr/bin/wrangler",
      ready: true,
    })
    expect(detectCliMock).toHaveBeenCalledWith("wrangler")
    expect(approveMock).toHaveBeenCalledWith("/usr/bin/wrangler")
  })
})

describe("redetectWranglerBinary", () => {
  it("invalidates the native cache then re-probes and approves", async () => {
    approveMock.mockResolvedValue(undefined)
    detectCliMock.mockResolvedValue(result({ path: "/usr/bin/wrangler" }))
    await expect(redetectWranglerBinary()).resolves.toMatchObject({ ready: true })
    expect(invokeMock).toHaveBeenCalledWith("detect_binary_invalidate", { name: "wrangler" })
    expect(approveMock).toHaveBeenCalledWith("/usr/bin/wrangler")
  })

  it("re-probes even if cache invalidation fails", async () => {
    approveMock.mockResolvedValue(undefined)
    invokeMock.mockRejectedValue(new Error("no ipc"))
    detectCliMock.mockResolvedValue(result({ path: "/usr/bin/wrangler" }))
    await expect(redetectWranglerBinary()).resolves.toMatchObject({ ready: true })
  })

  it("skips native cache invalidation off the desktop host", async () => {
    isTauriMock.mockReturnValue(false)
    detectCliMock.mockResolvedValue(result({ available: false, path: null, version: null }))
    await expect(redetectWranglerBinary()).resolves.toMatchObject({ ready: false })
    expect(invokeMock).not.toHaveBeenCalled()
  })
})
