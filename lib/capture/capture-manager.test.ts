import { persistCapture, detectSourceApp, subscribeCapturePersisted } from "./capture-manager"
import { findCapturedByFingerprint, saveCapturedItem } from "@/lib/db/captured-items"
import { isTauri } from "@/lib/native/utils"
import { invoke } from "@tauri-apps/api/core"
import type { CaptureCandidate } from "@/types/capture"
import { recordCaptureGovernance } from "@/lib/governance/producers/capture"
import { reportGovernanceProjectionFailure } from "@/lib/db/governance-ledger"

jest.mock("@/lib/db/captured-items", () => ({
  findCapturedByFingerprint: jest.fn(),
  saveCapturedItem: jest.fn(),
}))
jest.mock("@/lib/native/utils", () => ({ isTauri: jest.fn(() => false) }))
jest.mock("@tauri-apps/api/core", () => ({ invoke: jest.fn() }))
jest.mock("@/lib/governance/producers/capture", () => ({ recordCaptureGovernance: jest.fn() }))
jest.mock("@/lib/db/governance-ledger", () => ({
  reportGovernanceProjectionFailure: jest.fn(),
}))

const mockFind = findCapturedByFingerprint as jest.Mock
const mockSave = saveCapturedItem as jest.Mock
const mockIsTauri = isTauri as jest.Mock
const mockInvoke = invoke as jest.Mock
const mockRecordGovernance = jest.mocked(recordCaptureGovernance)
const mockReportGovernanceFailure = jest.mocked(reportGovernanceProjectionFailure)

const candidate: CaptureCandidate = {
  kind: "url",
  text: "https://x.test",
  sourceUrl: "https://x.test",
  sourceApp: "Chrome",
  fingerprint: "fp1",
}

beforeEach(() => {
  jest.clearAllMocks()
  mockIsTauri.mockReturnValue(false)
  mockRecordGovernance.mockResolvedValue("capture-evidence")
  mockReportGovernanceFailure.mockResolvedValue(undefined)
})

describe("persistCapture", () => {
  it("dedups on fingerprint", async () => {
    mockFind.mockResolvedValue({ id: "existing" })
    expect(await persistCapture(candidate, { deps: {} })).toBeNull()
    expect(mockSave).not.toHaveBeenCalled()
  })

  it("enriches and saves a new capture", async () => {
    mockFind.mockResolvedValue(undefined)
    const deps = { readUrl: async () => ({ markdown: "# Page", title: "Page" }) }
    const item = await persistCapture(candidate, { deps, now: 5000 })
    expect(item?.kind).toBe("url")
    expect(item?.sourceApp).toBe("Chrome")
    expect(item?.enrichment).toEqual({ markdown: "# Page", title: "Page", via: "url-reader" })
    expect(item?.capturedAt).toBe(5000)
    expect(mockSave).toHaveBeenCalledWith(item)
    expect(mockRecordGovernance).toHaveBeenCalledWith(item)
  })

  it("publishes a metadata-only event after a new capture is persisted", async () => {
    mockFind.mockResolvedValue(undefined)
    const listener = jest.fn()
    const unsubscribe = subscribeCapturePersisted(listener)

    const item = await persistCapture(candidate, { deps: {}, now: 5000 })

    expect(listener).toHaveBeenCalledWith({
      captureId: item?.id,
      kind: "url",
      capturedAt: 5000,
    })
    expect(JSON.stringify(listener.mock.calls)).not.toContain("https://x.test")

    unsubscribe()
  })

  it("records a content-free audit gap when governance projection fails", async () => {
    mockFind.mockResolvedValue(undefined)
    const projectionError = new Error("projection failed for alice@example.com")
    mockRecordGovernance.mockRejectedValueOnce(projectionError)

    const item = await persistCapture(candidate, { deps: {}, now: 5000 })

    expect(item).toBeTruthy()
    expect(mockReportGovernanceFailure).toHaveBeenCalledWith(
      {
        producer: "capture",
        operation: "persist",
        subjectRef: {
          namespace: "cognia",
          type: "capture",
          id: item?.id,
        },
        occurredAt: 5000,
      },
      projectionError
    )
  })

  it("uses default dependencies/time for a minimal non-enriched capture", async () => {
    mockFind.mockResolvedValue(undefined)

    const item = await persistCapture({ kind: "image", fingerprint: "image-fp" })

    expect(item).toEqual(
      expect.objectContaining({
        kind: "image",
        fingerprint: "image-fp",
        capturedAt: expect.any(Number),
      })
    )
    expect(item).not.toHaveProperty("text")
    expect(item).not.toHaveProperty("sourceUrl")
    expect(item).not.toHaveProperty("sourceApp")
    expect(item).not.toHaveProperty("enrichment")
  })

  it("isolates a throwing persisted observer from persistence and other observers", async () => {
    mockFind.mockResolvedValue(undefined)
    const healthy = jest.fn()
    const stopThrowing = subscribeCapturePersisted(() => {
      throw new Error("observer failed")
    })
    const stopHealthy = subscribeCapturePersisted(healthy)

    await expect(persistCapture(candidate, { deps: {}, now: 5000 })).resolves.toBeTruthy()
    expect(healthy).toHaveBeenCalledTimes(1)

    stopThrowing()
    stopHealthy()
  })
})

describe("detectSourceApp", () => {
  it("returns undefined off Tauri", async () => {
    expect(await detectSourceApp()).toBeUndefined()
  })

  it("returns the foreground app name on Tauri", async () => {
    mockIsTauri.mockReturnValue(true)
    mockInvoke.mockResolvedValue({ name: "Safari" })

    expect(await detectSourceApp()).toBe("Safari")
    expect(mockInvoke).toHaveBeenCalledWith("get_foreground_app")
  })

  it("returns undefined for an empty response or bridge failure", async () => {
    mockIsTauri.mockReturnValue(true)
    mockInvoke.mockResolvedValueOnce(null)
    await expect(detectSourceApp()).resolves.toBeUndefined()

    mockInvoke.mockRejectedValueOnce(new Error("bridge failed"))
    await expect(detectSourceApp()).resolves.toBeUndefined()
  })
})
