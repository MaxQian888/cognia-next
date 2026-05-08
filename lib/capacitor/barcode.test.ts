/**
 * @jest-environment jsdom
 */
import { scan } from "./barcode"

function makeScanner(overrides: Record<string, unknown> = {}) {
  return {
    requestPermissions: jest.fn().mockResolvedValue({ camera: "granted" }),
    checkPermissions: jest.fn().mockResolvedValue({ camera: "granted" }),
    scan: jest.fn().mockResolvedValue({ barcodes: [{ rawValue: "PAYLOAD" }] }),
    isSupported: jest.fn().mockResolvedValue({ supported: true }),
    ...overrides,
  } as {
    requestPermissions: jest.Mock
    checkPermissions: jest.Mock
    scan: jest.Mock
    isSupported: jest.Mock
  }
}

describe("scan", () => {
  it("returns scanned with rawValue on success", async () => {
    const s = makeScanner()
    const out = await scan({ loader: async () => s })
    expect(out).toEqual({ kind: "scanned", raw: "PAYLOAD" })
  })

  it("returns unsupported when isSupported returns false", async () => {
    const s = makeScanner({ isSupported: jest.fn().mockResolvedValue({ supported: false }) })
    const out = await scan({ loader: async () => s })
    expect(out).toEqual({ kind: "unsupported" })
  })

  it("requests permission when not granted", async () => {
    const s = makeScanner({
      checkPermissions: jest.fn().mockResolvedValue({ camera: "prompt" }),
      requestPermissions: jest.fn().mockResolvedValue({ camera: "granted" }),
    })
    const out = await scan({ loader: async () => s })
    expect(s.requestPermissions).toHaveBeenCalled()
    expect(out).toEqual({ kind: "scanned", raw: "PAYLOAD" })
  })

  it("returns permission_denied when permission denied", async () => {
    const s = makeScanner({
      checkPermissions: jest.fn().mockResolvedValue({ camera: "prompt" }),
      requestPermissions: jest.fn().mockResolvedValue({ camera: "denied" }),
    })
    const out = await scan({ loader: async () => s })
    expect(out).toEqual({ kind: "permission_denied" })
  })

  it("returns cancelled when no barcodes detected", async () => {
    const s = makeScanner({ scan: jest.fn().mockResolvedValue({ barcodes: [] }) })
    const out = await scan({ loader: async () => s })
    expect(out).toEqual({ kind: "cancelled" })
  })

  it("returns unsupported when loader rejects", async () => {
    const out = await scan({
      loader: async () => {
        throw new Error("no plugin")
      },
    })
    expect(out).toEqual({ kind: "unsupported" })
  })

  it("returns error for unexpected throws", async () => {
    const s = makeScanner({
      scan: jest.fn().mockRejectedValue(new Error("camera busy")),
    })
    const out = await scan({ loader: async () => s })
    expect(out).toEqual({ kind: "error", message: "camera busy" })
  })

  it("forwards custom formats", async () => {
    const s = makeScanner()
    await scan({ formats: ["AZTEC", "DATA_MATRIX"], loader: async () => s })
    expect(s.scan).toHaveBeenCalledWith({ formats: ["AZTEC", "DATA_MATRIX"] })
  })
})
