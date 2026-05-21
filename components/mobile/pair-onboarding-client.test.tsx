/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import {
  PairOnboardingClient,
  describeHttpError,
  describeNetworkError,
  validateBaseUrl,
  validatePairJwt,
} from "./pair-onboarding-client"
import type { DiscoveredServer } from "@/lib/connectivity/lan-scanner"

const VALID_JWT = "aaa.bbb.ccc"

// Stub the transport singleton — no real RPC layer in jsdom.
jest.mock("@/lib/tauri", () => ({
  transport: {
    call: jest.fn(),
    subscribe: jest.fn().mockReturnValue(() => {}),
    constructor: { name: "MockTransport" },
  },
}))

// Stub the QR scanner; keep the legacy mock path so any transitive callers keep working.
jest.mock("@/lib/capacitor/barcode", () => ({ scan: jest.fn() }))
jest.mock("@/lib/qr/barcode-scanner", () => ({ scanQrCode: jest.fn() }))

// Stub the LAN scanner — the coordinator imports DiscoverStep, which imports
// scanLan. Per-step tests cover the scan internals directly.
const mockScanLan = jest.fn()
jest.mock("@/lib/connectivity/lan-scanner", () => ({
  scanLan: (opts: unknown) => mockScanLan(opts),
}))

// next/navigation — useRouter().push is used after Continue-to-chat.
const pushMock = jest.fn()
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock, replace: jest.fn(), back: jest.fn() }),
}))

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) => {
    const map: Record<string, string> = {
      title: "Connect to desktop",
      intro: "Pick a server or paste the pairing code.",
      loadingTitle: "Checking for an existing pairing…",
      // Stepper labels.
      discover: "Discover",
      pair: "Pair",
      paired: "Done",
      ariaLabel: "Pairing progress",
      // Discover step copy used through children.
      "discover.title": "Find your desktop",
      "discover.subtitle": "Pick a server or use a QR/manual code.",
      "discover.scanning": "Scanning your network…",
      "discover.rescanCta": "Scan again",
      "discover.foundCount": `Found ${(vars?.count as number) ?? 0}`,
      "discover.emptyTitle": "No servers found",
      "discover.emptyDescription": "Make sure both devices share Wi-Fi.",
      "discover.skipToManual": "Use QR or manual entry",
      "discover.viaMdns": "mDNS",
      "discover.viaProbe": "Probe",
      "discover.viaHistory": "Last used",
      "discover.tlsPinned": "TLS pinned",
      "discover.tlsUnverified": "TLS unverified",
      "discover.latencyMs": `${(vars?.ms as number) ?? 0} ms`,
      "discover.baseUrlLocked": "Server locked",
      "discover.backToDiscover": "Back to discover",
      "permissions.localNetwork.title": "Local network blocked",
      "permissions.localNetwork.description": "Open Settings to grant access.",
      "permissions.localNetwork.openSettings": "Open Settings",
      // Pair step copy.
      scanCta: "Scan QR",
      manualDivider: "or paste manually",
      baseUrlLabel: "Server URL",
      tokenLabel: "Pair token",
      fingerprintPinned: "Desktop identity pinned",
      fingerprintHint: "Pinned to this signing key.",
      formCardTitle: "Pair this phone",
      formCardDescription: "One-tap scan or manual paste.",
      submit: "Pair",
      submitInProgress: "Pairing…",
      errorTitle: "Pairing failed",
      "scanError.notPairCode": "QR code scanned but its payload is not a cognia pairing code.",
      "scanError.permissionDenied": "Camera permission denied.",
      "scanError.unsupported": "QR scan only available on mobile app.",
      "scanError.failed": `QR scan failed: ${(vars?.message as string) ?? ""}`,
      // Paired step copy.
      transportLabel: "Transport",
      connectedTitle: "Connected to desktop",
      connectedSubtitle: "Live link.",
      offlineTitle: "Connection lost",
      offlineSubtitle: "Couldn't reach the desktop.",
      checkingTitle: "Re-checking link",
      "health.device": "Device",
      "health.server": "Server",
      "health.lastHeartbeat": "Last heartbeat",
      "health.latency": "Latency",
      "health.live": "Live",
      "health.checking": "Checking",
      "health.offline": "Offline",
      "health.refresh": "Refresh status",
      "health.continueToChat": "Continue to chat",
      "health.noHeartbeat": "—",
      "diagnostics.title": "Diagnostics",
      "diagnostics.subtitle": "Probe the link.",
      "diagnostics.expand": "Show diagnostics",
      "diagnostics.collapse": "Hide diagnostics",
      "diagnostics.testRpc": "Test RPC",
      "diagnostics.testWs": "Test event",
      "diagnostics.rpcResultLabel": "RPC response",
      "diagnostics.wsResultLabel": "Event payload",
      "diagnostics.rpcWaiting": "Tap Test RPC.",
      "diagnostics.wsWaiting": "Tap Test event.",
      "signOut.cardTitle": "Disconnect",
      "signOut.cardDescription": "Sign out and re-pair.",
      "signOut.cta": "Sign out / re-pair",
      signOutTitle: "Sign out",
      signOutReason: "Confirm sign out",
      signOutDescription: "You'll need to scan a QR again to reconnect.",
      biometricFailed: `Biometric failed (${(vars?.reason as string) ?? ""})`,
    }
    return map[key] ?? key
  },
}))

beforeEach(() => {
  window.localStorage.clear()
  ;(globalThis as unknown as { fetch: jest.Mock }).fetch = jest.fn()
  pushMock.mockReset()
  mockScanLan.mockReset()
  // Default scan stub: settles fast with no hits.
  mockScanLan.mockImplementation(async () => [])
})

afterEach(() => {
  jest.clearAllMocks()
})

describe("<PairOnboardingClient /> — coordinator", () => {
  it("starts on the discover step when no companion config exists", async () => {
    render(<PairOnboardingClient />)
    expect(await screen.findByTestId("pair-discover-step")).toBeInTheDocument()
    expect(screen.getByTestId("pair-stepper")).toBeInTheDocument()
    expect(screen.getByTestId("pair-onboarding")).toHaveAttribute("data-step", "discover")
  })

  it("hydrates and lands on the paired step when storage already has a config", async () => {
    window.localStorage.setItem(
      "cognia.companion.config.v1",
      JSON.stringify({
        baseUrl: "http://test:7890",
        deviceJwt: "jwt",
        deviceId: "dev-existing",
        serverVersion: "9.9.9",
      })
    )
    render(<PairOnboardingClient />)
    expect(await screen.findByTestId("pair-paired-step")).toBeInTheDocument()
    expect(screen.getByTestId("pair-onboarding")).toHaveAttribute("data-step", "paired")
    expect(screen.getByTestId("pair-status")).toHaveTextContent("dev-existing")
  })

  it("Skip from discover advances to the pair step with an empty form", async () => {
    const user = userEvent.setup()
    render(<PairOnboardingClient />)
    await user.click(await screen.findByTestId("pair-discover-skip"))
    expect(await screen.findByTestId("pair-pair-step")).toBeInTheDocument()
    expect((screen.getByTestId("pair-baseurl") as HTMLInputElement).value).toBe("")
    expect(screen.getByTestId("pair-onboarding")).toHaveAttribute("data-step", "pair")
  })

  it("picking a discovered server prefills + locks the URL field on the pair step", async () => {
    const hit: DiscoveredServer = {
      id: "192.168.1.42:7890",
      hostname: "cognia-AB12.local",
      ip: "192.168.1.42",
      port: 7890,
      baseUrl: "https://cognia-AB12.local:7890",
      source: "mdns",
      fingerprint: "ABCD1234EFGH5678",
      serverVersion: "0.4.2",
      discoveredAt: 0,
    }
    mockScanLan.mockImplementation(
      async ({ onFound }: { onFound: (s: DiscoveredServer) => void }) => {
        onFound(hit)
        return [hit]
      }
    )
    const user = userEvent.setup()
    render(<PairOnboardingClient />)
    await user.click(await screen.findByTestId("pair-server-card"))
    expect(await screen.findByTestId("pair-pair-step")).toBeInTheDocument()
    const baseUrl = screen.getByTestId("pair-baseurl") as HTMLInputElement
    expect(baseUrl.value).toBe("https://cognia-AB12.local:7890")
    expect(baseUrl).toHaveAttribute("readonly")
    expect(screen.getByTestId("pair-fingerprint-pin")).toBeInTheDocument()
  })

  it("Back from pair step returns to discover", async () => {
    const user = userEvent.setup()
    render(<PairOnboardingClient />)
    await user.click(await screen.findByTestId("pair-discover-skip"))
    await user.click(await screen.findByTestId("pair-back-to-discover"))
    expect(await screen.findByTestId("pair-discover-step")).toBeInTheDocument()
  })

  it("transitions discover → pair → paired on a successful pair", async () => {
    const fetchMock = (globalThis as unknown as { fetch: jest.Mock }).fetch
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          device_id: "dev-001",
          device_jwt: "jwt.value",
          server_version: "0.1.0",
        }),
      text: () => Promise.resolve(""),
    })
    const user = userEvent.setup()
    render(<PairOnboardingClient />)
    await user.click(await screen.findByTestId("pair-discover-skip"))
    fireEvent.change(screen.getByTestId("pair-baseurl"), {
      target: { value: "http://192.168.1.42:7890" },
    })
    // The pair step defaults to the 6-digit code tab; switch to the JWT
    // tab before populating the textarea (whose testid is gated on it).
    await user.click(screen.getByTestId("pair-tab-jwt"))
    fireEvent.change(screen.getByTestId("pair-jwt"), { target: { value: VALID_JWT } })
    await user.click(screen.getByTestId("pair-submit"))
    await waitFor(() => expect(screen.getByTestId("pair-paired-step")).toBeInTheDocument())
    expect(screen.getByTestId("pair-status")).toHaveTextContent("dev-001")
  })

  it("Continue to chat pushes the user to the mobile shell at /", async () => {
    window.localStorage.setItem(
      "cognia.companion.config.v1",
      JSON.stringify({
        baseUrl: "http://test:7890",
        deviceJwt: "jwt",
        deviceId: "dev-existing",
        serverVersion: "9.9.9",
      })
    )
    const user = userEvent.setup()
    render(<PairOnboardingClient />)
    await user.click(await screen.findByTestId("pair-continue-cta"))
    expect(pushMock).toHaveBeenCalledWith("/")
  })

  it("sign-out wipes the config and routes back to discover", async () => {
    window.localStorage.setItem(
      "cognia.companion.config.v1",
      JSON.stringify({
        baseUrl: "http://test:7890",
        deviceJwt: "jwt",
        deviceId: "dev-existing",
        serverVersion: "9.9.9",
      })
    )
    const user = userEvent.setup()
    render(<PairOnboardingClient />)
    await user.click(await screen.findByTestId("pair-signout"))
    await waitFor(() => expect(screen.getByTestId("pair-discover-step")).toBeInTheDocument())
    expect(window.localStorage.getItem("cognia.companion.config.v1")).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Pure helpers (re-exported from ./pair/pair-helpers)
// ---------------------------------------------------------------------------

describe("validateBaseUrl", () => {
  it("rejects empty input", () => {
    expect(validateBaseUrl("")).toMatch(/required/i)
  })
  it("rejects malformed URLs", () => {
    expect(validateBaseUrl("not a url")).toMatch(/URL like http:/i)
  })
  it("rejects non-http(s) protocols", () => {
    expect(validateBaseUrl("ftp://host:21")).toMatch(/http:\/\/ or https:\/\//i)
  })
  it("accepts http with port", () => {
    expect(validateBaseUrl("http://192.168.1.10:7890")).toBeNull()
  })
  it("accepts https with hostname", () => {
    expect(validateBaseUrl("https://cognia.local")).toBeNull()
  })
})

describe("validatePairJwt", () => {
  it("rejects empty", () => {
    expect(validatePairJwt("")).toMatch(/required/i)
  })
  it("rejects single-segment input", () => {
    expect(validatePairJwt("notajwt")).toMatch(/three dot-separated/i)
  })
  it("rejects two-segment input", () => {
    expect(validatePairJwt("aa.bb")).toMatch(/three dot-separated/i)
  })
  it("rejects empty segments", () => {
    expect(validatePairJwt("aa..cc")).toMatch(/non-empty/i)
  })
  it("rejects non-base64url chars", () => {
    expect(validatePairJwt("aa.b!b.cc")).toMatch(/base64url/i)
  })
  it("accepts a base64url-shaped JWT", () => {
    expect(validatePairJwt("aaa.bbb.ccc")).toBeNull()
  })
  it("accepts the dash + underscore base64url alphabet", () => {
    expect(validatePairJwt("AbC-_1.AbC-_2.AbC-_3")).toBeNull()
  })
})

describe("describeHttpError", () => {
  it("hints to regenerate the pairing code on 401", () => {
    expect(describeHttpError(401, "")).toMatch(/expired/i)
  })
  it("hints at allow-list on 403", () => {
    expect(describeHttpError(403, "")).toMatch(/allow-list/i)
  })
  it("hints at server version on 404", () => {
    expect(describeHttpError(404, "")).toMatch(/v0\.2\+/i)
  })
  it("formats 5xx with the body", () => {
    expect(describeHttpError(503, "")).toMatch(/Server error \(HTTP 503\)/)
  })
  it("falls back to a generic message with body", () => {
    expect(describeHttpError(418, "i am a teapot")).toMatch(/HTTP 418/)
  })
})

describe("describeNetworkError", () => {
  it("recognises Failed to fetch", () => {
    expect(describeNetworkError(new Error("Failed to fetch"))).toMatch(/same network/i)
  })
  it("recognises ECONNREFUSED", () => {
    expect(describeNetworkError(new Error("connect ECONNREFUSED"))).toMatch(/same network/i)
  })
  it("falls through to the raw message for unknown errors", () => {
    expect(describeNetworkError(new Error("custom blowup"))).toBe("custom blowup")
  })
  it("stringifies non-Error throws", () => {
    expect(describeNetworkError("something")).toBe("something")
  })
})
