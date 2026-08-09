/**
 * @jest-environment jsdom
 */

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import {
  PairOnboardingClient,
  readPairParams,
  resolveParamSelection,
} from "./pair-onboarding-client"
import type { DiscoveredServer } from "@/lib/connectivity/lan-scanner"
import { encodePairPayload } from "@/lib/qr/pair-payload"

const PAIR_PAYLOAD = encodePairPayload({
  baseUrl: "https://desktop.example:27890",
  mode: "owner-invitation",
  invitation: "owner-invitation",
  hostId: "host-1",
  tenantId: "local_acct_a",
  expiresAt: Date.now() + 60_000,
  serverVersion: "0.1.0",
  fingerprint: "sha256:paired-spki",
})
const mockRegisterPairPayload = jest.fn()

jest.mock("@/components/mobile/pair/pair-api", () => ({
  registerPairPayload: (...args: unknown[]) => mockRegisterPairPayload(...args),
}))

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
jest.mock("@/lib/signaling/v2-crypto", () => ({
  generatePersistableV2SigningIdentity: async () => ({
    privateKey: {},
    publicKey: {},
    privateKeyJwk: { kty: "EC", crv: "P-256", d: "private" },
    encodedPublicKey: "mobile-signing-key",
  }),
  buildRoomDescriptorV2: async (input: Record<string, unknown>) => ({
    v: 2,
    roomId: "room-1",
    ...input,
  }),
  importV2SigningPrivateKey: async () => ({}),
}))

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
  mockRegisterPairPayload.mockReset().mockResolvedValue({
    kind: "ok",
    config: {
      baseUrl: "https://desktop.example:27890",
      devicePrivateKeyJwk: { kty: "EC", crv: "P-256", d: "device-private" },
      deviceKeyThumbprint: "device-thumbprint",
      deviceId: "dev-001",
      serverVersion: "0.1.0",
    },
  })
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
        devicePrivateKeyJwk: { kty: "EC", crv: "P-256", d: "device-private" },
        deviceKeyThumbprint: "device-thumbprint",
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
    expect(screen.getByTestId("pair-payload")).toHaveValue("")
    expect(screen.getByTestId("pair-onboarding")).toHaveAttribute("data-step", "pair")
  })

  it("picking a discovered server still requires a fresh one-shot invitation", async () => {
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
    expect(screen.getByTestId("pair-payload")).toHaveValue("")
  })

  it("Back from pair step returns to discover", async () => {
    const user = userEvent.setup()
    render(<PairOnboardingClient />)
    await user.click(await screen.findByTestId("pair-discover-skip"))
    await user.click(screen.getByRole("button", { name: "Back to discover" }))
    expect(await screen.findByTestId("pair-discover-step")).toBeInTheDocument()
  })

  it("transitions discover → pair → paired on a successful pair", async () => {
    const user = userEvent.setup()
    render(<PairOnboardingClient />)
    await user.click(await screen.findByTestId("pair-discover-skip"))
    fireEvent.change(screen.getByTestId("pair-payload"), { target: { value: PAIR_PAYLOAD } })
    await user.click(screen.getByTestId("pair-submit"))
    await waitFor(() => expect(screen.getByTestId("pair-paired-step")).toBeInTheDocument())
    expect(screen.getByTestId("pair-status")).toHaveTextContent("dev-001")
    expect(mockRegisterPairPayload).toHaveBeenCalledWith(PAIR_PAYLOAD)
  })

  it("Continue to chat pushes the user to the mobile shell at /", async () => {
    window.localStorage.setItem(
      "cognia.companion.config.v1",
      JSON.stringify({
        baseUrl: "http://test:7890",
        devicePrivateKeyJwk: { kty: "EC", crv: "P-256", d: "device-private" },
        deviceKeyThumbprint: "device-thumbprint",
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
        devicePrivateKeyJwk: { kty: "EC", crv: "P-256", d: "device-private" },
        deviceKeyThumbprint: "device-thumbprint",
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

  it("does not derive credentials from NEXT_PUBLIC_COGNIA_SERVER_URL", async () => {
    process.env.NEXT_PUBLIC_COGNIA_SERVER_URL = "https://cloud.example.com:7890/"
    render(<PairOnboardingClient />)
    expect(await screen.findByTestId("pair-payload")).toHaveValue("")
  })

  it("sign-out returns to the pair step, not discover", async () => {
    window.localStorage.setItem(
      "cognia.companion.config.v1",
      JSON.stringify({
        baseUrl: "http://test:7890",
        devicePrivateKeyJwk: { kty: "EC", crv: "P-256", d: "device-private" },
        deviceKeyThumbprint: "device-thumbprint",
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

  it("does not turn an explicit baseUrl into a pairing credential", () => {
    const sel = resolveParamSelection(
      { switchTo: null, baseUrl: "https://192.168.1.7:7890", fingerprint: "FP-X" },
      RECENTS
    )
    expect(sel).toBeNull()
  })

  it("does not restore an invitation through the recent-server label", () => {
    const sel = resolveParamSelection(
      { switchTo: "deviceAA-full-uuid", baseUrl: null, fingerprint: null },
      RECENTS
    )
    expect(sel).toBeNull()
  })

  it("does not restore an invitation even for an exact remembered deviceId", () => {
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
    expect(sel).toBeNull()
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

  it("ignores ?baseUrl= and requires discovery or a fresh QR", async () => {
    window.history.replaceState(null, "", "/pair?baseUrl=https%3A%2F%2F192.168.1.7%3A7890")
    render(<PairOnboardingClient />)
    expect(await screen.findByTestId("pair-discover-step")).toBeInTheDocument()
    expect(screen.getByTestId("pair-onboarding")).toHaveAttribute("data-step", "discover")
  })

  it("requires a fresh invitation when switching to a remembered server", async () => {
    // Currently paired to dev-existing; switching to dev-other (remembered).
    window.localStorage.setItem(
      "cognia.companion.config.v1",
      JSON.stringify({
        baseUrl: "http://test:7890",
        devicePrivateKeyJwk: { kty: "EC", crv: "P-256", d: "device-private" },
        deviceKeyThumbprint: "device-thumbprint",
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
    expect(await screen.findByTestId("pair-discover-step")).toBeInTheDocument()
  })

  it("stays on the paired step when switchTo targets the already-active device", async () => {
    window.localStorage.setItem(
      "cognia.companion.config.v1",
      JSON.stringify({
        baseUrl: "http://test:7890",
        devicePrivateKeyJwk: { kty: "EC", crv: "P-256", d: "device-private" },
        deviceKeyThumbprint: "device-thumbprint",
        deviceId: "dev-existing",
        serverVersion: "9.9.9",
      })
    )
    window.history.replaceState(null, "", "/pair?switchTo=dev-existing")
    render(<PairOnboardingClient />)
    expect(await screen.findByTestId("pair-paired-step")).toBeInTheDocument()
  })
})
