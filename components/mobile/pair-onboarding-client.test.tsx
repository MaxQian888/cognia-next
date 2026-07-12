/**
 * @jest-environment jsdom
 */

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import {
  PairOnboardingClient,
  describeHttpError,
  describeNetworkError,
  readPairParams,
  resolveParamSelection,
  validateBaseUrl,
  validatePairJwt,
} from "./pair-onboarding-client"
import type { DiscoveredServer } from "@/lib/connectivity/lan-scanner"

const VALID_JWT = "aaa.bbb.ccc"

// The coordinator branches on the runtime platform (ADR-0059 C2): jsdom
// detects as "web", which would flip every legacy test into the web pair
// flow — pin "mobile" by default and let the web-mode cases override.
let platformMock: "tauri" | "mobile" | "web" = "mobile"
jest.mock("@/hooks/use-platform", () => ({
  usePlatform: () => platformMock,
}))

// Stub the transport singleton — no real RPC layer in jsdom.
jest.mock("@/lib/tauri", () => ({
  isTauri: jest.fn().mockReturnValue(false),
  transport: {
    call: jest.fn(),
    subscribe: jest.fn().mockReturnValue(() => {}),
    constructor: { name: "MockTransport" },
  },
}))

// Stub the QR scanner; keep the legacy mock path so any transitive callers keep working.
jest.mock("@/lib/capacitor/barcode", () => ({ scan: jest.fn() }))
jest.mock("@/lib/qr/barcode-scanner", () => ({ scanQrCode: jest.fn() }))

// Control hydration timing so the loading-screen escape paths are testable.
// Defaults mirror the real LocalStorage backend (read/clear the config key)
// so the existing hydrate/sign-out cases behave exactly as before.
const COMPANION_KEY = "cognia.companion.config.v1"
let hydrateImpl: () => Promise<unknown> = async () => {
  const raw = window.localStorage.getItem(COMPANION_KEY)
  return raw ? JSON.parse(raw) : null
}
let clearImpl: () => Promise<void> = async () => {
  window.localStorage.removeItem(COMPANION_KEY)
}
jest.mock("@/lib/tauri/transport-companion", () => ({
  hydrateCompanionConfig: () => hydrateImpl(),
  clearCompanionConfig: () => clearImpl(),
  saveCompanionConfig: async (config: unknown) => {
    window.localStorage.setItem(COMPANION_KEY, JSON.stringify(config))
  },
}))

// Stub the LAN scanner — the coordinator imports DiscoverStep, which imports
// scanLan. Per-step tests cover the scan internals directly.
const mockScanLan = jest.fn()
jest.mock("@/lib/connectivity/lan-scanner", () => ({
  scanLan: (opts: unknown) => mockScanLan(opts),
  rankSource: (s: string) =>
    (({ paired: 4, mdns: 3, probe: 2, history: 1 }) as Record<string, number>)[s] ?? 0,
}))

// DiscoverStep pre-flights /healthz before advancing — resolve it so a tapped
// server reaches the pair step. Haptics is a no-op on web; stub to silence it.
jest.mock("@/lib/connectivity/healthz", () => ({
  fetchHealthz: async () => ({
    version: "0.4.2",
    fingerprint: "HZ-FP",
    advertisedPort: 7890,
    serverId: "srv-1",
  }),
}))
jest.mock("@/lib/capacitor/haptics", () => ({
  impact: jest.fn(async () => ({ kind: "unsupported" })),
  notify: jest.fn(async () => ({ kind: "unsupported" })),
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
  platformMock = "mobile"
  delete process.env.NEXT_PUBLIC_COGNIA_SERVER_URL
  window.localStorage.clear()
  ;(globalThis as unknown as { fetch: jest.Mock }).fetch = jest.fn()
  pushMock.mockReset()
  mockScanLan.mockReset()
  // Default scan stub: settles fast with no hits.
  mockScanLan.mockImplementation(async () => [])
  // Reset hydrate/clear to the localStorage-backed defaults.
  hydrateImpl = async () => {
    const raw = window.localStorage.getItem(COMPANION_KEY)
    return raw ? JSON.parse(raw) : null
  }
  clearImpl = async () => {
    window.localStorage.removeItem(COMPANION_KEY)
  }
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

  it("reveals a manual escape when hydration stalls, and tapping it shows discover", async () => {
    jest.useFakeTimers()
    try {
      // Hydration that never settles — the device-stall scenario that used to
      // trap the user on the spinner forever.
      hydrateImpl = () => new Promise(() => {})
      render(<PairOnboardingClient />)
      expect(screen.getByTestId("pair-onboarding")).toHaveAttribute("data-step", "loading")
      // No escape yet — under the slow-hint threshold.
      expect(screen.queryByTestId("pair-loading-skip")).not.toBeInTheDocument()

      act(() => {
        jest.advanceTimersByTime(2500)
      })
      const skip = screen.getByTestId("pair-loading-skip")
      act(() => {
        fireEvent.click(skip)
      })
      expect(screen.getByTestId("pair-discover-step")).toBeInTheDocument()
      // Flush the discover step's async LAN scan so its trailing setState
      // doesn't fire outside act after the test ends.
      await act(async () => {
        await Promise.resolve()
      })
    } finally {
      jest.useRealTimers()
    }
  })

  it("auto-falls through to discover after the ceiling when hydration never settles", async () => {
    jest.useFakeTimers()
    try {
      hydrateImpl = () => new Promise(() => {})
      render(<PairOnboardingClient />)
      expect(screen.getByTestId("pair-onboarding")).toHaveAttribute("data-step", "loading")
      act(() => {
        jest.advanceTimersByTime(8000)
      })
      expect(screen.getByTestId("pair-discover-step")).toBeInTheDocument()
      await act(async () => {
        await Promise.resolve()
      })
    } finally {
      jest.useRealTimers()
    }
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

describe("<PairOnboardingClient /> — web host (ADR-0059 C2)", () => {
  beforeEach(() => {
    platformMock = "web"
  })

  it("skips discover and lands straight on the pair step", async () => {
    render(<PairOnboardingClient />)
    expect(await screen.findByTestId("pair-pair-step")).toBeInTheDocument()
    expect(screen.queryByTestId("pair-discover-step")).not.toBeInTheDocument()
    expect(screen.getByTestId("pair-onboarding")).toHaveAttribute("data-step", "pair")
  })

  it("renders a two-step stepper (no Discover) and hides QR + back affordances", async () => {
    render(<PairOnboardingClient />)
    await screen.findByTestId("pair-pair-step")
    const stepper = screen.getByTestId("pair-stepper")
    expect(stepper.querySelectorAll("li")).toHaveLength(2)
    expect(screen.queryByTestId("pair-scan-qr")).not.toBeInTheDocument()
    expect(screen.queryByTestId("pair-back-to-discover")).not.toBeInTheDocument()
    expect(screen.getByTestId("pair-web-storage-notice")).toBeInTheDocument()
  })

  it("prefills and locks the server URL from NEXT_PUBLIC_COGNIA_SERVER_URL", async () => {
    process.env.NEXT_PUBLIC_COGNIA_SERVER_URL = "https://cloud.example.com:7890/"
    render(<PairOnboardingClient />)
    const baseUrl = (await screen.findByTestId("pair-baseurl")) as HTMLInputElement
    expect(baseUrl.value).toBe("https://cloud.example.com:7890")
    expect(baseUrl).toHaveAttribute("readonly")
  })

  it("sign-out returns to the pair step, not discover", async () => {
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
    await waitFor(() => expect(screen.getByTestId("pair-pair-step")).toBeInTheDocument())
    expect(screen.queryByTestId("pair-discover-step")).not.toBeInTheDocument()
  })
})

// ---------------------------------------------------------------------------
// Pure helpers (re-exported from ./pair/pair-helpers)
// ---------------------------------------------------------------------------

describe("readPairParams / resolveParamSelection", () => {
  const RECENTS = [
    {
      baseUrl: "https://192.168.1.5:7890",
      fingerprint: "FP-A",
      label: "deviceAA",
      lastSeenAt: 1,
    },
    { baseUrl: "https://192.168.1.9:7890", label: "deviceBB", lastSeenAt: 2 },
  ]

  it("parses switchTo/baseUrl/fingerprint from a search string", () => {
    expect(readPairParams("?switchTo=deviceAA-1234&baseUrl=https%3A%2F%2Fx&fingerprint=F")).toEqual(
      { switchTo: "deviceAA-1234", baseUrl: "https://x", fingerprint: "F" }
    )
    expect(readPairParams("")).toEqual({ switchTo: null, baseUrl: null, fingerprint: null })
  })

  it("prefers an explicit baseUrl param and locks the selection", () => {
    const sel = resolveParamSelection(
      { switchTo: null, baseUrl: "https://192.168.1.7:7890", fingerprint: "FP-X" },
      RECENTS
    )
    expect(sel).toEqual({
      baseUrl: "https://192.168.1.7:7890",
      pairJwt: "",
      fingerprint: "FP-X",
      locked: true,
      autoScan: false,
    })
  })

  it("resolves switchTo through the recent-server label (deviceId prefix)", () => {
    const sel = resolveParamSelection(
      { switchTo: "deviceAA-full-uuid", baseUrl: null, fingerprint: null },
      RECENTS
    )
    expect(sel).toEqual({
      baseUrl: "https://192.168.1.5:7890",
      pairJwt: "",
      fingerprint: "FP-A",
      locked: true,
      autoScan: false,
    })
  })

  it("resolves switchTo by exact deviceId ahead of the legacy label match", () => {
    const recents = [
      // Legacy-label decoy: label happens to equal the switchTo prefix.
      { baseUrl: "https://decoy:7890", label: "deviceAA", lastSeenAt: 1 },
      {
        baseUrl: "https://real:7890",
        fingerprint: "FP-R",
        label: "other",
        deviceId: "deviceAA-full-uuid",
        lastSeenAt: 2,
      },
    ]
    const sel = resolveParamSelection(
      { switchTo: "deviceAA-full-uuid", baseUrl: null, fingerprint: null },
      recents
    )
    expect(sel?.baseUrl).toBe("https://real:7890")
    expect(sel?.fingerprint).toBe("FP-R")
  })

  it("returns null for a switchTo with no recent record and for empty params", () => {
    expect(
      resolveParamSelection({ switchTo: "unknown-device", baseUrl: null, fingerprint: null }, [])
    ).toBeNull()
    expect(
      resolveParamSelection({ switchTo: null, baseUrl: null, fingerprint: null }, RECENTS)
    ).toBeNull()
  })
})

describe("<PairOnboardingClient /> — incoming query params", () => {
  afterEach(() => {
    window.history.replaceState(null, "", "/pair")
  })

  it("lands on the pair step with the server pre-filled for ?baseUrl=", async () => {
    window.history.replaceState(null, "", "/pair?baseUrl=https%3A%2F%2F192.168.1.7%3A7890")
    render(<PairOnboardingClient />)
    expect(await screen.findByTestId("pair-pair-step")).toBeInTheDocument()
    expect(screen.getByTestId("pair-onboarding")).toHaveAttribute("data-step", "pair")
    expect(screen.getByTestId("pair-baseurl")).toHaveValue("https://192.168.1.7:7890")
  })

  it("lands on the pair step for ?switchTo= of a different, remembered server", async () => {
    // Currently paired to dev-existing; switching to dev-other (remembered).
    window.localStorage.setItem(
      "cognia.companion.config.v1",
      JSON.stringify({
        baseUrl: "http://test:7890",
        deviceJwt: "jwt",
        deviceId: "dev-existing",
        serverVersion: "9.9.9",
      })
    )
    window.localStorage.setItem(
      "cognia.mobile.recentServers",
      JSON.stringify([
        { baseUrl: "https://10.0.0.9:7890", fingerprint: "FP-B", label: "dev-othe", lastSeenAt: 5 },
      ])
    )
    window.history.replaceState(null, "", "/pair?switchTo=dev-other-uuid")
    render(<PairOnboardingClient />)
    expect(await screen.findByTestId("pair-pair-step")).toBeInTheDocument()
    expect(screen.getByTestId("pair-baseurl")).toHaveValue("https://10.0.0.9:7890")
  })

  it("stays on the paired step when switchTo targets the already-active device", async () => {
    window.localStorage.setItem(
      "cognia.companion.config.v1",
      JSON.stringify({
        baseUrl: "http://test:7890",
        deviceJwt: "jwt",
        deviceId: "dev-existing",
        serverVersion: "9.9.9",
      })
    )
    window.history.replaceState(null, "", "/pair?switchTo=dev-existing")
    render(<PairOnboardingClient />)
    expect(await screen.findByTestId("pair-paired-step")).toBeInTheDocument()
  })
})

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
