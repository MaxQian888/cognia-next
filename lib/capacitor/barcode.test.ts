/**
 * @jest-environment jsdom
 */
import { scan } from "./barcode"
import { getGooglePlayServicesStatus } from "./google-play-services"
import { openBarcodeScanView, waitForBarcodeScanViewHost } from "./barcode-scan-session"

jest.mock("./google-play-services", () => ({ getGooglePlayServicesStatus: jest.fn() }))
jest.mock("./barcode-scan-session", () => ({
  openBarcodeScanView: jest.fn(),
  waitForBarcodeScanViewHost: jest.fn(),
}))

beforeEach(() => {
  jest.mocked(getGooglePlayServicesStatus).mockResolvedValue({ available: true, status: 0 })
  jest.mocked(waitForBarcodeScanViewHost).mockResolvedValue(undefined)
})

describe("Android bundled scanner", () => {
  const callbacks = new Map<string, (event: Record<string, unknown>) => void>()
  const close = jest.fn()
  const setTorch = jest.fn()
  const tick = async () => {
    for (let i = 0; i < 30; i++) await Promise.resolve()
  }
  const bundled = () => ({
    ...makeScanner(),
    startScan: jest.fn().mockResolvedValue(undefined),
    stopScan: jest.fn().mockResolvedValue(undefined),
    addListener: jest.fn().mockImplementation(async (name, callback) => {
      callbacks.set(name, callback)
      return {
        remove: jest.fn(async () => {
          callbacks.delete(name)
        }),
      }
    }),
  })

  beforeEach(() => {
    ;(globalThis as { Capacitor?: unknown }).Capacitor = { getPlatform: () => "android" }
    callbacks.clear()
    close.mockClear()
    setTorch.mockClear()
    jest.mocked(getGooglePlayServicesStatus).mockResolvedValue({ available: false, status: 1 })
    jest.mocked(openBarcodeScanView).mockReturnValue({ close, setTorch })
  })
  afterEach(() => {
    delete (globalThis as { Capacitor?: unknown }).Capacitor
    jest.useRealTimers()
  })

  it.each([1, 2, 3, 9, "unknown"] as const)(
    "uses bundled scanning for GMS status %s and cleans up after a result",
    async (status) => {
      jest.mocked(getGooglePlayServicesStatus).mockResolvedValue({ available: false, status })
      const scanner = bundled()
      const result = scan({ loader: async () => scanner })
      await tick()
      expect(scanner.startScan).toHaveBeenCalledWith({ formats: ["QR_CODE"], lensFacing: "BACK" })
      expect(scanner.scan).not.toHaveBeenCalled()
      callbacks.get("barcodesScanned")?.({ barcodes: [{ rawValue: "OFFLINE-QR" }] })
      expect(await result).toEqual({ kind: "scanned", raw: "OFFLINE-QR" })
      expect(scanner.stopScan).toHaveBeenCalledTimes(1)
      expect(callbacks.size).toBe(0)
      expect(close).toHaveBeenCalledTimes(1)
    }
  )

  it("requires app camera permission only for the bundled route", async () => {
    const scanner = bundled()
    scanner.checkPermissions.mockResolvedValue({ camera: "denied" })
    scanner.requestPermissions.mockResolvedValue({ camera: "denied" })
    expect(await scan({ loader: async () => scanner })).toEqual({ kind: "permission_denied" })
    expect(scanner.startScan).not.toHaveBeenCalled()
    expect(openBarcodeScanView).not.toHaveBeenCalled()
  })

  it("cancels the camera and listeners when the user closes the scan view", async () => {
    const scanner = bundled()
    const result = scan({ loader: async () => scanner })
    await tick()
    jest.mocked(openBarcodeScanView).mock.calls[0][0].onCancel()
    expect(await result).toEqual({ kind: "cancelled" })
    expect(scanner.stopScan).toHaveBeenCalledTimes(1)
    expect(callbacks.size).toBe(0)
    expect(close).toHaveBeenCalledTimes(1)
  })

  it("falls back when GMS exists but its scanner module fails to download", async () => {
    jest.mocked(getGooglePlayServicesStatus).mockResolvedValue({ available: true, status: 0 })
    const scanner = {
      ...bundled(),
      isGoogleBarcodeScannerModuleAvailable: jest.fn().mockResolvedValue({ available: false }),
      installGoogleBarcodeScannerModule: jest.fn().mockRejectedValue(new Error("offline")),
    }
    const result = scan({ loader: async () => scanner })
    await tick()
    expect(scanner.startScan).toHaveBeenCalledTimes(1)
    expect(callbacks.has("googleBarcodeScannerModuleInstallProgress")).toBe(false)
    callbacks.get("barcodesScanned")?.({ barcodes: [{ rawValue: "FALLBACK" }] })
    expect(await result).toEqual({ kind: "scanned", raw: "FALLBACK" })
  })

  it("preserves Google UI cancellation instead of opening a second camera", async () => {
    jest.mocked(getGooglePlayServicesStatus).mockResolvedValue({ available: true, status: 0 })
    const scanner = bundled()
    scanner.scan.mockRejectedValue(new Error("scan canceled."))
    expect(await scan({ loader: async () => scanner })).toEqual({ kind: "cancelled" })
    expect(scanner.startScan).not.toHaveBeenCalled()
  })

  it.each(["abort", "pagehide", "hidden"])(
    "stops capture on %s and ignores late barcodes",
    async (reason) => {
      const scanner = bundled()
      const controller = new AbortController()
      const result = scan({ loader: async () => scanner, signal: controller.signal })
      await tick()
      const late = callbacks.get("barcodesScanned")
      if (reason === "abort") controller.abort()
      else if (reason === "hidden") {
        const visibility = jest.spyOn(document, "visibilityState", "get").mockReturnValue("hidden")
        document.dispatchEvent(new Event("visibilitychange"))
        visibility.mockRestore()
      } else window.dispatchEvent(new Event("pagehide"))
      late?.({ barcodes: [{ rawValue: "LATE" }] })
      expect(await result).toEqual({ kind: "cancelled" })
      expect(scanner.stopScan).toHaveBeenCalledTimes(1)
      expect(close).toHaveBeenCalledTimes(1)
      expect(callbacks.size).toBe(0)
    }
  )

  it("toggles the native torch and closes capture after a torch error", async () => {
    const scanner = {
      ...bundled(),
      isTorchAvailable: jest.fn().mockResolvedValue({ available: true }),
      enableTorch: jest.fn().mockResolvedValue(undefined),
      disableTorch: jest.fn().mockResolvedValue(undefined),
    }
    const result = scan({ loader: async () => scanner })
    await tick()
    const toggle = jest.mocked(openBarcodeScanView).mock.calls[0][0].onToggleTorch!
    await toggle()
    expect(scanner.enableTorch).toHaveBeenCalledTimes(1)
    expect(setTorch).toHaveBeenLastCalledWith(true)
    await toggle()
    expect(scanner.disableTorch).toHaveBeenCalledTimes(1)
    expect(setTorch).toHaveBeenLastCalledWith(false)
    scanner.enableTorch.mockRejectedValueOnce(new Error("torch unavailable"))
    await toggle()
    expect(await result).toEqual({ kind: "error", message: "torch unavailable" })
    expect(scanner.stopScan).toHaveBeenCalledTimes(1)
    expect(callbacks.size).toBe(0)
  })

  it("waits for camera initialization before applying an early torch tap", async () => {
    let started!: () => void
    const scanner = {
      ...bundled(),
      isTorchAvailable: jest.fn().mockResolvedValue({ available: true }),
      enableTorch: jest.fn().mockResolvedValue(undefined),
      disableTorch: jest.fn().mockResolvedValue(undefined),
    }
    scanner.startScan.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          started = resolve
        })
    )
    const result = scan({ loader: async () => scanner })
    await tick()
    const view = jest.mocked(openBarcodeScanView).mock.calls[0][0]
    const toggled = view.onToggleTorch!()
    await tick()
    const callsBeforeReady = scanner.enableTorch.mock.calls.length
    started()
    await toggled
    view.onCancel()
    expect(await result).toEqual({ kind: "cancelled" })
    expect(callsBeforeReady).toBe(0)
    expect(scanner.enableTorch).toHaveBeenCalledTimes(1)
    expect(setTorch).toHaveBeenLastCalledWith(true)
  })

  it("stops a camera that finishes initialization after cancellation before allowing another scan", async () => {
    const scanner = bundled()
    let started!: () => void
    scanner.startScan.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          started = resolve
        })
    )
    const controller = new AbortController()
    const result = scan({ loader: async () => scanner, signal: controller.signal })
    await tick()
    controller.abort()
    expect(await result).toEqual({ kind: "cancelled" })
    expect(await scan({ loader: async () => scanner })).toMatchObject({
      kind: "error",
      message: "barcode scanner is busy",
    })
    started()
    await tick()
    expect(scanner.stopScan).toHaveBeenCalledTimes(2)
    scanner.scan.mockResolvedValue({ barcodes: [{ rawValue: "NEXT" }] })
    jest.mocked(getGooglePlayServicesStatus).mockResolvedValue({ available: true, status: 0 })
    expect(await scan({ loader: async () => scanner })).toEqual({ kind: "scanned", raw: "NEXT" })
  })

  it("cleans up a failed startup and a streaming camera error", async () => {
    const scanner = bundled()
    scanner.startScan.mockRejectedValueOnce(new Error("camera busy"))
    expect(await scan({ loader: async () => scanner })).toEqual({
      kind: "error",
      message: "camera busy",
    })
    expect(scanner.stopScan).toHaveBeenCalledTimes(1)
    expect(close).toHaveBeenCalledTimes(1)
    const result = scan({ loader: async () => scanner })
    await tick()
    callbacks.get("scanError")?.({ message: "camera disconnected" })
    expect(await result).toEqual({ kind: "error", message: "camera disconnected" })
    expect(scanner.stopScan).toHaveBeenCalledTimes(2)
    expect(callbacks.size).toBe(0)
  })

  it("waits for the boot-time scan screen before starting native capture", async () => {
    let ready!: () => void
    jest.mocked(waitForBarcodeScanViewHost).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          ready = resolve
        })
    )
    const scanner = bundled()
    const result = scan({ loader: async () => scanner })
    await tick()
    expect(scanner.startScan).not.toHaveBeenCalled()
    ready()
    await tick()
    expect(scanner.startScan).toHaveBeenCalledTimes(1)
    jest.mocked(openBarcodeScanView).mock.calls[0][0].onCancel()
    expect(await result).toEqual({ kind: "cancelled" })
  })

  it("bounds startup and removes a listener that registers after cancellation", async () => {
    jest.useFakeTimers()
    const scanner = bundled()
    let registered!: (handle: { remove: jest.Mock }) => void
    const remove = jest.fn().mockResolvedValue(undefined)
    scanner.addListener.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          registered = resolve
        })
    )
    const result = scan({ loader: async () => scanner })
    await jest.advanceTimersByTimeAsync(10_000)
    expect(await result).toEqual({ kind: "error", message: "barcode camera startup timed out" })
    registered({ remove })
    await jest.advanceTimersByTimeAsync(0)
    expect(remove).toHaveBeenCalledTimes(1)
    expect(scanner.startScan).not.toHaveBeenCalled()
    expect(close).toHaveBeenCalledTimes(1)
    expect(jest.getTimerCount()).toBe(0)
  })
})

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

  it.each([new Error("scan canceled."), { message: "scan canceled." }, "scan canceled."])(
    "normalizes native scan dismissal (%p)",
    async (error) => {
      const s = makeScanner({ scan: jest.fn().mockRejectedValue(error) })
      expect(await scan({ loader: async () => s })).toEqual({ kind: "cancelled" })
    }
  )

  it("forwards custom formats", async () => {
    const s = makeScanner()
    await scan({ formats: ["AZTEC", "DATA_MATRIX"], loader: async () => s })
    expect(s.scan).toHaveBeenCalledWith({ formats: ["AZTEC", "DATA_MATRIX"] })
  })

  describe("Android Google Barcode Scanner module gate", () => {
    const setPlatform = (p: string | undefined) => {
      ;(globalThis as { Capacitor?: unknown }).Capacitor = p ? { getPlatform: () => p } : undefined
    }
    afterEach(() => {
      setPlatform(undefined)
      jest.useRealTimers()
    })

    it("opens Android's permission-free scanner even when app camera permission is denied", async () => {
      setPlatform("android")
      const s = makeScanner({
        checkPermissions: jest.fn().mockResolvedValue({ camera: "denied" }),
        requestPermissions: jest.fn().mockResolvedValue({ camera: "denied" }),
      })
      expect(await scan({ loader: async () => s })).toEqual({ kind: "scanned", raw: "PAYLOAD" })
      expect(s.checkPermissions).not.toHaveBeenCalled()
      expect(s.requestPermissions).not.toHaveBeenCalled()
    })

    it("cleans the listener when the installation request rejects", async () => {
      setPlatform("android")
      const remove = jest.fn().mockResolvedValue(undefined)
      const s = makeScanner({
        isGoogleBarcodeScannerModuleAvailable: jest.fn().mockResolvedValue({ available: false }),
        installGoogleBarcodeScannerModule: jest
          .fn()
          .mockRejectedValue(new Error("download failed")),
        addListener: jest.fn().mockResolvedValue({ remove }),
      })
      expect(await scan({ loader: async () => s })).toEqual({
        kind: "error",
        message: "download failed",
      })
      expect(remove).toHaveBeenCalledTimes(1)
      expect(s.scan).not.toHaveBeenCalled()
    })

    it("rechecks availability if another installer wins the installation race", async () => {
      setPlatform("android")
      const remove = jest.fn().mockResolvedValue(undefined)
      const s = makeScanner({
        isGoogleBarcodeScannerModuleAvailable: jest
          .fn()
          .mockResolvedValueOnce({ available: false })
          .mockResolvedValue({ available: true }),
        installGoogleBarcodeScannerModule: jest
          .fn()
          .mockRejectedValue(new Error("already installed")),
        addListener: jest.fn().mockResolvedValue({ remove }),
      })
      expect(await scan({ loader: async () => s })).toEqual({ kind: "scanned", raw: "PAYLOAD" })
      expect(remove).toHaveBeenCalledTimes(1)
    })

    it.each([true, false])(
      "times out unavailable modules (listener support: %s)",
      async (hasListener) => {
        jest.useFakeTimers()
        setPlatform("android")
        const remove = jest.fn().mockResolvedValue(undefined)
        const s = makeScanner({
          isGoogleBarcodeScannerModuleAvailable: jest.fn().mockResolvedValue({ available: false }),
          installGoogleBarcodeScannerModule: jest.fn().mockResolvedValue(undefined),
          ...(hasListener ? { addListener: jest.fn().mockResolvedValue({ remove }) } : {}),
        })
        const outcome = scan({ loader: async () => s })
        await jest.advanceTimersByTimeAsync(60_000)
        expect(await outcome).toEqual({
          kind: "error",
          message: "barcode module installation timed out",
        })
        expect(s.scan).not.toHaveBeenCalled()
        expect(remove).toHaveBeenCalledTimes(hasListener ? 1 : 0)
        expect(jest.getTimerCount()).toBe(0)
      }
    )

    it("waits for actual availability when progress events are unsupported", async () => {
      jest.useFakeTimers()
      setPlatform("android")
      const available = jest
        .fn()
        .mockResolvedValueOnce({ available: false })
        .mockResolvedValueOnce({ available: false })
        .mockResolvedValue({ available: true })
      const s = makeScanner({
        isGoogleBarcodeScannerModuleAvailable: available,
        installGoogleBarcodeScannerModule: jest.fn().mockResolvedValue(undefined),
      })
      const outcome = scan({ loader: async () => s })
      await jest.advanceTimersByTimeAsync(0)
      expect(s.scan).not.toHaveBeenCalled()
      await jest.advanceTimersByTimeAsync(500)
      expect(await outcome).toEqual({ kind: "scanned", raw: "PAYLOAD" })
      expect(jest.getTimerCount()).toBe(0)
    })

    it("removes a late listener after timeout without starting installation or scan", async () => {
      jest.useFakeTimers()
      setPlatform("android")
      const remove = jest.fn().mockResolvedValue(undefined)
      let register!: (handle: { remove: typeof remove }) => void
      const install = jest.fn()
      const s = makeScanner({
        isGoogleBarcodeScannerModuleAvailable: jest.fn().mockResolvedValue({ available: false }),
        installGoogleBarcodeScannerModule: install,
        addListener: jest.fn().mockImplementation(
          () =>
            new Promise((resolve) => {
              register = resolve
            })
        ),
      })
      const outcome = scan({ loader: async () => s })
      await jest.advanceTimersByTimeAsync(60_000)
      expect(await outcome).toEqual({
        kind: "error",
        message: "barcode module installation timed out",
      })
      register({ remove })
      await jest.advanceTimersByTimeAsync(0)
      expect(remove).toHaveBeenCalledTimes(1)
      expect(install).not.toHaveBeenCalled()
      expect(s.scan).not.toHaveBeenCalled()
      expect(jest.getTimerCount()).toBe(0)
    })

    it("does not touch the module methods on iOS", async () => {
      setPlatform("ios")
      const isAvail = jest.fn().mockResolvedValue({ available: false })
      const install = jest.fn()
      const s = makeScanner({
        isGoogleBarcodeScannerModuleAvailable: isAvail,
        installGoogleBarcodeScannerModule: install,
      })
      const out = await scan({ loader: async () => s })
      expect(isAvail).not.toHaveBeenCalled()
      expect(install).not.toHaveBeenCalled()
      expect(out).toEqual({ kind: "scanned", raw: "PAYLOAD" })
    })

    it("skips install on Android when the module is already available", async () => {
      setPlatform("android")
      const install = jest.fn()
      const s = makeScanner({
        isGoogleBarcodeScannerModuleAvailable: jest.fn().mockResolvedValue({ available: true }),
        installGoogleBarcodeScannerModule: install,
      })
      const out = await scan({ loader: async () => s })
      expect(install).not.toHaveBeenCalled()
      expect(out).toEqual({ kind: "scanned", raw: "PAYLOAD" })
    })

    it("installs the module then scans when it is unavailable (COMPLETED event)", async () => {
      setPlatform("android")
      let progressCb: ((e: { state: number }) => void) | undefined
      const remove = jest.fn().mockResolvedValue(undefined)
      const install = jest.fn().mockImplementation(async () => {
        progressCb?.({ state: 4 }) // COMPLETED
      })
      const s = makeScanner({
        isGoogleBarcodeScannerModuleAvailable: jest.fn().mockResolvedValue({ available: false }),
        installGoogleBarcodeScannerModule: install,
        addListener: jest
          .fn()
          .mockImplementation(async (_e: string, cb: (e: { state: number }) => void) => {
            progressCb = cb
            return { remove }
          }),
      })
      const out = await scan({ loader: async () => s })
      expect(install).toHaveBeenCalled()
      expect(remove).toHaveBeenCalled() // listener cleaned up
      expect(out).toEqual({ kind: "scanned", raw: "PAYLOAD" })
    })

    it("returns an error when the module install fails (FAILED event)", async () => {
      setPlatform("android")
      let progressCb: ((e: { state: number }) => void) | undefined
      const s = makeScanner({
        isGoogleBarcodeScannerModuleAvailable: jest.fn().mockResolvedValue({ available: false }),
        installGoogleBarcodeScannerModule: jest.fn().mockImplementation(async () => {
          progressCb?.({ state: 5 }) // FAILED (e.g. no Google Play Services)
        }),
        addListener: jest
          .fn()
          .mockImplementation(async (_e: string, cb: (e: { state: number }) => void) => {
            progressCb = cb
            return { remove: jest.fn().mockResolvedValue(undefined) }
          }),
        scan: jest.fn(),
      })
      const out = await scan({ loader: async () => s })
      expect(out.kind).toBe("error")
      expect(s.scan).not.toHaveBeenCalled() // never reached native scan
    })

    it("returns cancelled when module installation is canceled and cleans its listener", async () => {
      setPlatform("android")
      let progress: ((event: { state: number }) => void) | undefined
      const remove = jest.fn().mockResolvedValue(undefined)
      const s = makeScanner({
        isGoogleBarcodeScannerModuleAvailable: jest.fn().mockResolvedValue({ available: false }),
        installGoogleBarcodeScannerModule: jest
          .fn()
          .mockImplementation(async () => progress?.({ state: 3 })),
        addListener: jest
          .fn()
          .mockImplementation(async (_event: string, handler: typeof progress) => {
            progress = handler
            return { remove }
          }),
      })
      expect(await scan({ loader: async () => s })).toEqual({ kind: "cancelled" })
      expect(remove).toHaveBeenCalledTimes(1)
      expect(s.scan).not.toHaveBeenCalled()
    })
  })
})
