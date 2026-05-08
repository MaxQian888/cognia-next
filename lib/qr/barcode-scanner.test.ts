/**
 * @jest-environment jsdom
 */

import { scanQrCode } from "./barcode-scanner"

interface FakeScannerOpts {
  isSupported?: boolean
  initialPerm?: "granted" | "denied" | "limited" | "prompt" | "prompt-with-rationale"
  postRequestPerm?: "granted" | "denied" | "limited" | "prompt" | "prompt-with-rationale"
  scan?: { rawValue: string }[]
  scanThrows?: Error
  isSupportedThrows?: Error
}

function makeScanner(opts: FakeScannerOpts = {}) {
  let permState = opts.initialPerm ?? "prompt"
  return {
    isSupported: jest.fn(async () => {
      if (opts.isSupportedThrows) throw opts.isSupportedThrows
      return { supported: opts.isSupported ?? true }
    }),
    checkPermissions: jest.fn(async () => ({ camera: permState })),
    requestPermissions: jest.fn(async () => {
      permState = opts.postRequestPerm ?? "granted"
      return { camera: permState }
    }),
    scan: jest.fn(async () => {
      if (opts.scanThrows) throw opts.scanThrows
      return { barcodes: opts.scan ?? [{ rawValue: '{"baseUrl":"u","pairJwt":"j"}' }] }
    }),
  }
}

describe("scanQrCode", () => {
  it("returns scanned with the raw QR value on success", async () => {
    const scanner = makeScanner({ initialPerm: "granted" })
    const out = await scanQrCode({ loader: async () => scanner })
    expect(out).toEqual({ kind: "scanned", raw: '{"baseUrl":"u","pairJwt":"j"}' })
    expect(scanner.requestPermissions).not.toHaveBeenCalled()
  })

  it("requests permission when initially in prompt state", async () => {
    const scanner = makeScanner({ initialPerm: "prompt", postRequestPerm: "granted" })
    const out = await scanQrCode({ loader: async () => scanner })
    expect(out.kind).toBe("scanned")
    expect(scanner.requestPermissions).toHaveBeenCalled()
  })

  it("returns permission_denied when the user refuses", async () => {
    const scanner = makeScanner({ initialPerm: "prompt", postRequestPerm: "denied" })
    const out = await scanQrCode({ loader: async () => scanner })
    expect(out.kind).toBe("permission_denied")
    expect(scanner.scan).not.toHaveBeenCalled()
  })

  it("accepts the 'limited' iOS permission as good enough to scan", async () => {
    const scanner = makeScanner({ initialPerm: "limited" })
    const out = await scanQrCode({ loader: async () => scanner })
    expect(out.kind).toBe("scanned")
  })

  it("returns unsupported when the device doesn't have a camera", async () => {
    const scanner = makeScanner({ isSupported: false })
    const out = await scanQrCode({ loader: async () => scanner })
    expect(out.kind).toBe("unsupported")
  })

  it("returns unsupported when the loader itself rejects (web build)", async () => {
    const out = await scanQrCode({
      loader: async () => {
        throw new Error("module not found")
      },
    })
    expect(out.kind).toBe("unsupported")
  })

  it("returns cancelled when scan returns no barcodes", async () => {
    const scanner = makeScanner({ initialPerm: "granted", scan: [] })
    const out = await scanQrCode({ loader: async () => scanner })
    expect(out.kind).toBe("cancelled")
  })

  it("returns cancelled when scan returns a barcode with empty rawValue", async () => {
    const scanner = makeScanner({ initialPerm: "granted", scan: [{ rawValue: "" }] })
    const out = await scanQrCode({ loader: async () => scanner })
    expect(out.kind).toBe("cancelled")
  })

  it("returns error when scan rejects mid-flow", async () => {
    const scanner = makeScanner({
      initialPerm: "granted",
      scanThrows: new Error("camera busy"),
    })
    const out = await scanQrCode({ loader: async () => scanner })
    expect(out.kind).toBe("error")
    if (out.kind !== "error") return
    expect(out.message).toBe("camera busy")
  })

  it("returns error when isSupported rejects", async () => {
    const scanner = makeScanner({ isSupportedThrows: new Error("backend") })
    const out = await scanQrCode({ loader: async () => scanner })
    expect(out.kind).toBe("error")
  })
})
