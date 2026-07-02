import { persistCapture, detectSourceApp } from "./capture-manager"
import { findCapturedByFingerprint, saveCapturedItem } from "@/lib/db/captured-items"
import type { CaptureCandidate } from "@/types/capture"

jest.mock("@/lib/db/captured-items", () => ({
  findCapturedByFingerprint: jest.fn(),
  saveCapturedItem: jest.fn(),
}))
jest.mock("@/lib/native/utils", () => ({ isTauri: jest.fn(() => false) }))

const mockFind = findCapturedByFingerprint as jest.Mock
const mockSave = saveCapturedItem as jest.Mock

const candidate: CaptureCandidate = {
  kind: "url",
  text: "https://x.test",
  sourceUrl: "https://x.test",
  sourceApp: "Chrome",
  fingerprint: "fp1",
}

beforeEach(() => jest.clearAllMocks())

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
  })
})

describe("detectSourceApp", () => {
  it("returns undefined off Tauri", async () => {
    expect(await detectSourceApp()).toBeUndefined()
  })
})
