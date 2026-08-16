import type { MigrationVendorProbe } from "@/lib/agent-migration/types"
import {
  EMPTY_SCAN,
  SCAN_HARD_TIMEOUT_MS,
  SCAN_SOFT_TIMEOUT_MS,
  hasModelAccess,
  migratableVendors,
  resolveScanPhase,
  shellRunsMachineScan,
  type ScanResult,
  type ScannedRuntime,
} from "./scan"

const runtime = (patch: Partial<ScannedRuntime> = {}): ScannedRuntime => ({
  id: "claude-code",
  label: "Claude Code",
  authenticated: false,
  ...patch,
})

const scan = (patch: Partial<ScanResult> = {}): ScanResult => ({ ...EMPTY_SCAN, ...patch })

describe("hasModelAccess", () => {
  it("is false with nothing configured and nothing found", () => {
    expect(hasModelAccess({ scan: EMPTY_SCAN, hasSubscription: false })).toBe(false)
  })

  it("is true with a pasted API key", () => {
    expect(hasModelAccess({ scan: EMPTY_SCAN, apiKey: "sk-ant-x", hasSubscription: false })).toBe(
      true
    )
  })

  it("is true with an active subscription account", () => {
    expect(hasModelAccess({ scan: EMPTY_SCAN, hasSubscription: true })).toBe(true)
  })

  it("is true when a scanned runtime is already authenticated", () => {
    // This is the case that lets the flow skip the provider step entirely: the
    // machine can already reach a model without Cognia-side credentials.
    const out = hasModelAccess({
      scan: scan({ runtimes: [runtime({ authenticated: true })] }),
      hasSubscription: false,
    })
    expect(out).toBe(true)
  })

  it("is false when a runtime was found but is not authenticated", () => {
    const out = hasModelAccess({
      scan: scan({ runtimes: [runtime({ authenticated: false })] }),
      hasSubscription: false,
    })
    expect(out).toBe(false)
  })
})

describe("migratableVendors", () => {
  const probe = (vendor: MigrationVendorProbe["vendor"], installed: boolean) => ({
    vendor,
    installed,
  })

  it("keeps only installed vendors", () => {
    const out = migratableVendors([
      probe("claude-code", true),
      probe("codex", false),
      probe("opencode", true),
    ])
    expect(out).toEqual(["claude-code", "opencode"])
  })

  it("returns an empty list when nothing is installed", () => {
    expect(migratableVendors([probe("claude-code", false)])).toEqual([])
  })
})

describe("resolveScanPhase", () => {
  it("reports found as soon as anything turns up, regardless of timers", () => {
    expect(resolveScanPhase({ found: true, pending: true, elapsedMs: 0 })).toBe("found")
    expect(
      resolveScanPhase({ found: true, pending: false, elapsedMs: SCAN_HARD_TIMEOUT_MS + 1 })
    ).toBe("found")
  })

  it("scans below the soft timeout", () => {
    expect(resolveScanPhase({ found: false, pending: false, elapsedMs: 0 })).toBe("scanning")
    expect(
      resolveScanPhase({ found: false, pending: false, elapsedMs: SCAN_SOFT_TIMEOUT_MS - 1 })
    ).toBe("scanning")
  })

  it("flips to empty at the soft timeout when nothing is in flight", () => {
    expect(
      resolveScanPhase({ found: false, pending: false, elapsedMs: SCAN_SOFT_TIMEOUT_MS })
    ).toBe("empty")
  })

  it("keeps scanning past the soft timeout while the probe reports work in flight", () => {
    // The false-negative this whole policy exists to prevent: a probe still
    // running when the screen says "nothing found", so the user skips a step
    // that would have succeeded.
    expect(
      resolveScanPhase({ found: false, pending: true, elapsedMs: SCAN_SOFT_TIMEOUT_MS + 1 })
    ).toBe("scanning")
  })

  it("gives up at the hard ceiling even while the probe still claims to be working", () => {
    expect(resolveScanPhase({ found: false, pending: true, elapsedMs: SCAN_HARD_TIMEOUT_MS })).toBe(
      "empty"
    )
  })

  it("orders the ceiling above the soft budget", () => {
    expect(SCAN_HARD_TIMEOUT_MS).toBeGreaterThan(SCAN_SOFT_TIMEOUT_MS)
  })
})

describe("shellRunsMachineScan", () => {
  it("probes only on the desktop", () => {
    expect(shellRunsMachineScan("tauri")).toBe(true)
  })

  it("does not probe on a paired phone — the compute is on the desktop", () => {
    expect(shellRunsMachineScan("mobile-paired")).toBe(false)
  })

  it.each(["web", "mobile-standalone"] as const)("does not probe on %s", (shell) => {
    expect(shellRunsMachineScan(shell)).toBe(false)
  })
})
