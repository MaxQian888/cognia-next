import type { MigrationVendorProbe } from "@/lib/agent-migration/types"
import {
  EMPTY_SCAN,
  SCAN_HARD_TIMEOUT_MS,
  SCAN_SOFT_TIMEOUT_MS,
  hasModelAccess,
  migratableVendors,
  vendorLabel,
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
  const base = { credentialsOk: false as boolean | null, providerConfigured: false }

  it("is false with nothing configured and nothing found", () => {
    expect(hasModelAccess({ scan: EMPTY_SCAN, ...base })).toBe(false)
  })

  it("is true once the chat path's own credential probe says yes", () => {
    // Covers a keyring API key, an OAuth bearer, and standalone BYOK — the
    // three things `useCredentialStatus` already knows how to tell apart.
    expect(hasModelAccess({ scan: EMPTY_SCAN, ...base, credentialsOk: true })).toBe(true)
  })

  it("is true with a settings-resolved AI-SDK provider the Tauri probe cannot see", () => {
    // `hasApiKey()` reads an Anthropic-only env slot, so a desktop user running
    // entirely on OpenAI reads as `keyOk: false` and would be asked to sign in
    // to something they do not use.
    expect(hasModelAccess({ scan: EMPTY_SCAN, ...base, providerConfigured: true })).toBe(true)
  })

  it("is true with the legacy Anthropic key slot, without waiting on the probe", () => {
    // `settings.apiKey` is pushed into the Rust `ApiKeyState` at boot, so
    // `hasApiKey()` reports it only *after* that sync — later than the latch
    // takes its first settled answer.
    expect(hasModelAccess({ scan: EMPTY_SCAN, ...base, legacyApiKey: "sk-ant-x" })).toBe(true)
  })

  it("ignores a blank legacy key", () => {
    expect(hasModelAccess({ scan: EMPTY_SCAN, ...base, legacyApiKey: "   " })).toBe(false)
  })

  it("is true when a scanned runtime is already authenticated", () => {
    // This is the case that lets the flow skip the provider step entirely: the
    // machine can already reach a model without Cognia-side credentials.
    const out = hasModelAccess({
      scan: scan({ runtimes: [runtime({ authenticated: true })] }),
      ...base,
    })
    expect(out).toBe(true)
  })

  it("is false when a runtime was found but is not authenticated", () => {
    const out = hasModelAccess({
      scan: scan({ runtimes: [runtime({ authenticated: false })] }),
      ...base,
    })
    expect(out).toBe(false)
  })

  it("treats an unsettled probe as no access rather than as access", () => {
    // `null` is "the probe has not answered" (or a paired phone, which has
    // nothing local to answer with). Reading it as access would drop the
    // sign-in step for everyone during the first frames of the flow.
    expect(hasModelAccess({ scan: EMPTY_SCAN, ...base, credentialsOk: null })).toBe(false)
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

describe("vendorLabel", () => {
  it("names Pi, which the old hard-coded map could not", () => {
    // `VENDOR_RUNTIME.pi` held "pi", a runtime id, where a preset id belonged.
    // Nothing resolved it, so the row printed the raw slug at the user.
    expect(vendorLabel(EMPTY_SCAN, "pi")).toBe("Pi (native RPC)")
    expect(vendorLabel(EMPTY_SCAN, "pi")).not.toBe("pi")
  })

  it("prefers the label the scan already resolved", () => {
    const scan: ScanResult = {
      ...EMPTY_SCAN,
      runtimes: [runtime({ id: "pi-rpc", label: "Pi" })],
    }
    expect(vendorLabel(scan, "pi")).toBe("Pi")
  })

  it("ignores a runtime row whose id is not the vendor's preset", () => {
    const scan: ScanResult = {
      ...EMPTY_SCAN,
      runtimes: [runtime({ id: "codex", label: "Codex" })],
    }
    expect(vendorLabel(scan, "pi")).toBe("Pi (native RPC)")
  })

  it.each([
    ["claude-code", "Claude Code ACP adapter"],
    ["codex", "Codex ACP adapter"],
    ["opencode", "OpenCode (auto-spawn)"],
  ] as const)("resolves %s without a scan result", (vendor, expected) => {
    expect(vendorLabel(EMPTY_SCAN, vendor)).toBe(expected)
  })
})
