"use client"

import { makeDefaultLoader } from "./_shared"
import { getGooglePlayServicesStatus } from "./google-play-services"
import { openBarcodeScanView, waitForBarcodeScanViewHost } from "./barcode-scan-session"

/**
 * Barcode/QR scan via `@capacitor-mlkit/barcode-scanning`.
 *
 * Canonical wrapper shared by mobile callers and the legacy QR facade.
 */

export type ScanOutcome =
  | { kind: "scanned"; raw: string }
  | { kind: "permission_denied" }
  | { kind: "cancelled" }
  | { kind: "unsupported" }
  | { kind: "error"; message: string }

interface ModuleInstallProgressEvent {
  /** GoogleBarcodeScannerModuleInstallState (see constants below). */
  state: number
  progress?: number
}

interface ScannerEvents {
  googleBarcodeScannerModuleInstallProgress: ModuleInstallProgressEvent
  barcodesScanned: { barcodes: Array<{ rawValue?: string }> }
  scanError: { message: string }
}

type ListenerHandle = { remove: () => Promise<void> }

interface BarcodeScannerShape {
  requestPermissions(): Promise<{
    camera: "granted" | "denied" | "limited" | "prompt" | "prompt-with-rationale"
  }>
  checkPermissions(): Promise<{
    camera: "granted" | "denied" | "limited" | "prompt" | "prompt-with-rationale"
  }>
  scan(opts?: { formats?: string[] }): Promise<{ barcodes: Array<{ rawValue: string }> }>
  isSupported(): Promise<{ supported: boolean }>
  // Android-only: the native scan UI depends on the on-demand Google Barcode
  // Scanner module, which is absent on a fresh install until downloaded.
  isGoogleBarcodeScannerModuleAvailable?(): Promise<{ available: boolean }>
  installGoogleBarcodeScannerModule?(): Promise<void>
  addListener?<E extends keyof ScannerEvents>(
    event: E,
    cb: (e: ScannerEvents[E]) => void
  ): Promise<ListenerHandle>
  startScan?(options: { formats: string[]; lensFacing: "BACK" }): Promise<void>
  stopScan?(): Promise<void>
  isTorchAvailable?(): Promise<{ available: boolean }>
  enableTorch?(): Promise<void>
  disableTorch?(): Promise<void>
}

// GoogleBarcodeScannerModuleInstallState enum values (from
// @capacitor-mlkit/barcode-scanning). Kept as literals so we don't import the
// native package (absent from the web bundle).
const MODULE_STATE_CANCELED = 3
const MODULE_STATE_COMPLETED = 4
const MODULE_STATE_FAILED = 5
const MODULE_INSTALL_TIMEOUT_MS = 60_000
const MODULE_AVAILABILITY_POLL_MS = 500

export type BarcodeScannerLoader = () => Promise<BarcodeScannerShape>

// Resolve through the shared global-aware loader: on device the plugin proxy
// lives at `window.Capacitor.Plugins.BarcodeScanner` (populated by
// `registerNativePlugins()` at boot — see `register-plugins.ts`). The previous
// bare `import("@capacitor-mlkit/barcode-scanning")` could never resolve on
// device (mobile-workspace dep, not bundled), so QR-scan pairing silently
// reported `unsupported`.
const defaultLoader: BarcodeScannerLoader = makeDefaultLoader<BarcodeScannerShape>(
  "@capacitor-mlkit/barcode-scanning",
  "BarcodeScanner"
)

export interface ScanOptions {
  formats?: string[]
  loader?: BarcodeScannerLoader
  signal?: AbortSignal
}

/** Runtime Capacitor platform ("android" | "ios" | "web" | undefined). */
function capacitorPlatform(): string | undefined {
  return (globalThis as { Capacitor?: { getPlatform?: () => string } }).Capacitor?.getPlatform?.()
}

/**
 * On Android the native scan UI needs the Google Barcode Scanner module, which
 * ships on-demand: on a fresh device `scan()` rejects with `MODULE_UNAVAILABLE`
 * until it downloads. Ensure it's present first — check availability, and if
 * missing kick off the install and await completion or confirmed availability,
 * bounded by a deadline when the native bridge or module download stalls.
 *
 * Resolves once the module is ready; rejects if the install fails or is
 * canceled (e.g. a device without Google Play Services). No-op on iOS/web or
 * when the loaded plugin predates these methods.
 */
async function ensureGoogleModule(
  scanner: BarcodeScannerShape,
  signal?: AbortSignal
): Promise<void> {
  if (capacitorPlatform() !== "android") return
  if (
    typeof scanner.isGoogleBarcodeScannerModuleAvailable !== "function" ||
    typeof scanner.installGoogleBarcodeScannerModule !== "function"
  ) {
    return
  }
  await new Promise<void>((resolve, reject) => {
    let handle: { remove: () => Promise<void> } | undefined
    let settled = false
    let poll: ReturnType<typeof setTimeout> | undefined
    const removeListener = () => {
      void handle?.remove().catch(() => {})
      handle = undefined
    }
    const finish = (error?: unknown) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      clearTimeout(poll)
      signal?.removeEventListener("abort", onAbort)
      removeListener()
      if (error !== undefined) reject(error)
      else resolve()
    }
    const timeout = setTimeout(
      () => finish(new Error("barcode module installation timed out")),
      MODULE_INSTALL_TIMEOUT_MS
    )
    const onAbort = () => finish(new Error("scan canceled."))
    signal?.addEventListener("abort", onAbort, { once: true })
    if (signal?.aborted) return onAbort()
    const onProgress = (e: ModuleInstallProgressEvent) => {
      if (e.state === MODULE_STATE_COMPLETED) {
        finish()
      } else if (e.state === MODULE_STATE_CANCELED) {
        finish(new Error("scan canceled."))
      } else if (e.state === MODULE_STATE_FAILED) {
        finish(new Error(`barcode module install failed (state ${e.state})`))
      }
    }
    const checkAvailability = async () => {
      if (settled) return
      try {
        const { available } = await scanner.isGoogleBarcodeScannerModuleAvailable!()
        if (settled) return
        if (available) finish()
        else poll = setTimeout(() => void checkAvailability(), MODULE_AVAILABILITY_POLL_MS)
      } catch (error) {
        finish(error)
      }
    }
    const start = async () => {
      const { available } = await scanner.isGoogleBarcodeScannerModuleAvailable!()
      if (settled) return
      if (available) return finish()

      handle = await scanner.addListener?.("googleBarcodeScannerModuleInstallProgress", onProgress)
      // A timeout or terminal event can arrive before registration resolves.
      if (settled) return removeListener()
      try {
        await scanner.installGoogleBarcodeScannerModule!()
      } catch (error) {
        if (settled) return
        // Another installation can finish between the initial check and request.
        const current = await scanner.isGoogleBarcodeScannerModuleAvailable!()
        finish(current.available ? undefined : error)
        return
      }
      // Acceptance does not mean readiness. Poll also covers missing events or
      // older adapters without progress-listener support.
      await checkAvailability()
    }
    void start().catch(finish)
  })
}

const START_TIMEOUT_MS = 10_000
const CLEANUP_TIMEOUT_MS = 3_000
let scanInFlight = false
let pendingNativeStarts = 0

function messageOf(error: unknown): string {
  return typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
    ? error.message
    : String(error)
}

/** A stalled bridge cleanup must not leave the user trapped in the scan screen. */
async function settleCleanup(action: () => Promise<unknown>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      Promise.resolve()
        .then(action)
        .catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, CLEANUP_TIMEOUT_MS)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

function canScanBundled(scanner: BarcodeScannerShape): boolean {
  return !!(scanner.startScan && scanner.stopScan && scanner.addListener)
}

/** CameraX + the ML Kit model already bundled in the installed plugin. */
async function scanBundled(
  scanner: BarcodeScannerShape,
  formats: string[],
  signal?: AbortSignal
): Promise<ScanOutcome> {
  if (!canScanBundled(scanner)) return { kind: "unsupported" }
  let permission = await scanner.checkPermissions()
  if (signal?.aborted) return { kind: "cancelled" }
  if (permission.camera !== "granted" && permission.camera !== "limited") {
    permission = await scanner.requestPermissions()
  }
  if (signal?.aborted) return { kind: "cancelled" }
  if (permission.camera !== "granted" && permission.camera !== "limited")
    return { kind: "permission_denied" }

  return new Promise<ScanOutcome>((resolve) => {
    let settled = false
    let startAttempted = false
    let torchEnabled = false
    let torchBusy = false
    let releaseCameraWait!: () => void
    const cameraReady = new Promise<void>((resolve) => {
      releaseCameraWait = resolve
    })
    let view: ReturnType<typeof openBarcodeScanView> | undefined
    const lifetime = new AbortController()
    const handles: ListenerHandle[] = []
    const onCancel = () => finish({ kind: "cancelled" })
    const onVisibility = () => {
      if (document.visibilityState === "hidden") onCancel()
    }
    const finish = (outcome: ScanOutcome) => {
      if (settled) return
      settled = true
      releaseCameraWait()
      lifetime.abort()
      clearTimeout(startTimer)
      signal?.removeEventListener("abort", onCancel)
      document.removeEventListener("visibilitychange", onVisibility)
      window.removeEventListener("pagehide", onCancel)
      void (async () => {
        if (startAttempted) await settleCleanup(() => scanner.stopScan!())
        await Promise.all(handles.map((handle) => settleCleanup(() => handle.remove())))
        view?.close()
        resolve(outcome)
      })()
    }
    const startTimer = setTimeout(
      () => finish({ kind: "error", message: "barcode camera startup timed out" }),
      START_TIMEOUT_MS
    )
    signal?.addEventListener("abort", onCancel, { once: true })
    document.addEventListener("visibilitychange", onVisibility)
    window.addEventListener("pagehide", onCancel)
    if (signal?.aborted) return onCancel()

    const listen = async <E extends keyof ScannerEvents>(
      event: E,
      handler: (event: ScannerEvents[E]) => void
    ) => {
      const handle = await scanner.addListener!(event, handler)
      if (settled) await settleCleanup(() => handle.remove())
      else handles.push(handle)
    }
    const toggleTorch = async () => {
      if (settled || torchBusy) return
      torchBusy = true
      try {
        // Native enableTorch is a successful no-op before CameraX is bound.
        await cameraReady
        if (settled) return
        await (torchEnabled ? scanner.disableTorch!() : scanner.enableTorch!())
        if (!settled) {
          torchEnabled = !torchEnabled
          view?.setTorch(torchEnabled)
        }
      } catch (error) {
        finish({ kind: "error", message: messageOf(error) })
      } finally {
        torchBusy = false
      }
    }
    const start = async () => {
      await waitForBarcodeScanViewHost(lifetime.signal)
      if (settled) return
      let torchAvailable = false
      if (scanner.isTorchAvailable && scanner.enableTorch && scanner.disableTorch) {
        await settleCleanup(async () => {
          torchAvailable = (await scanner.isTorchAvailable!()).available
        })
      }
      if (settled) return
      view = openBarcodeScanView({
        onCancel,
        ...(torchAvailable ? { onToggleTorch: toggleTorch } : {}),
      })
      await listen("barcodesScanned", (event) => {
        const raw = event.barcodes.find((barcode) => !!barcode.rawValue)?.rawValue
        if (raw) finish({ kind: "scanned", raw })
      })
      if (settled) return
      await listen("scanError", (event) => finish({ kind: "error", message: event.message }))
      if (settled) return
      startAttempted = true
      pendingNativeStarts += 1
      try {
        await scanner.startScan!({ formats, lensFacing: "BACK" })
        releaseCameraWait()
        // Cancellation can race CameraX initialization. Keep new scan calls
        // excluded until this late startup has been stopped as well.
        if (settled) await settleCleanup(() => scanner.stopScan!())
        else clearTimeout(startTimer)
      } finally {
        pendingNativeStarts -= 1
      }
    }
    void start().catch((error) => finish({ kind: "error", message: messageOf(error) }))
  })
}

async function scanOnce(opts: ScanOptions): Promise<ScanOutcome> {
  const { formats = ["QR_CODE"], loader = defaultLoader, signal } = opts

  let scanner: BarcodeScannerShape
  try {
    scanner = await loader()
  } catch {
    return { kind: "unsupported" }
  }

  try {
    if (signal?.aborted) return { kind: "cancelled" }
    const support = await scanner.isSupported()
    if (!support.supported) return { kind: "unsupported" }
    if (signal?.aborted) return { kind: "cancelled" }

    if (capacitorPlatform() === "android") {
      const services = await getGooglePlayServicesStatus()
      if (signal?.aborted) return { kind: "cancelled" }
      if (!services.available) return await scanBundled(scanner, formats, signal)
      try {
        await ensureGoogleModule(scanner, signal)
        if (signal?.aborted) return { kind: "cancelled" }
        const result = await scanner.scan({ formats })
        if (signal?.aborted) return { kind: "cancelled" }
        const raw = result.barcodes.find((barcode) => !!barcode.rawValue)?.rawValue
        return raw ? { kind: "scanned", raw } : { kind: "cancelled" }
      } catch (error) {
        if (signal?.aborted || messageOf(error) === "scan canceled.") return { kind: "cancelled" }
        // GMS can be installed while its scanner module cannot download, or
        // become unavailable after detection. Use the offline model then too.
        if (canScanBundled(scanner)) return await scanBundled(scanner, formats, signal)
        throw error
      }
    }

    // iOS's ready-made scan UI uses the application's camera authorization.
    let perm = await scanner.checkPermissions()
    if (perm.camera !== "granted" && perm.camera !== "limited") {
      perm = await scanner.requestPermissions()
    }
    if (perm.camera !== "granted" && perm.camera !== "limited") {
      return { kind: "permission_denied" }
    }

    if (signal?.aborted) return { kind: "cancelled" }

    const result = await scanner.scan({ formats })
    if (signal?.aborted) return { kind: "cancelled" }
    const first = result.barcodes[0]
    if (!first || !first.rawValue) return { kind: "cancelled" }
    return { kind: "scanned", raw: first.rawValue }
  } catch (err: unknown) {
    const message = messageOf(err)
    // Both installed native implementations reject with this exact message.
    if (message === "scan canceled.") return { kind: "cancelled" }
    return {
      kind: "error",
      message,
    }
  }
}

export async function scan(opts: ScanOptions = {}): Promise<ScanOutcome> {
  if (opts.signal?.aborted) return { kind: "cancelled" }
  if (scanInFlight || pendingNativeStarts > 0)
    return { kind: "error", message: "barcode scanner is busy" }
  scanInFlight = true
  try {
    return await scanOnce(opts)
  } finally {
    scanInFlight = false
  }
}
