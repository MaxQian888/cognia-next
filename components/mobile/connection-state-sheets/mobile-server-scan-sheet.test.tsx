/**
 * @jest-environment jsdom
 */

import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { MobileServerScanSheet } from "./mobile-server-scan-sheet"
import type { DiscoveredServer } from "@/lib/connectivity/lan-scanner"

const routerPushMock = jest.fn()

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerPushMock }),
}))

let loadConfigImpl: () => unknown
jest.mock("@/lib/tauri/transport-companion", () => ({
  loadCompanionConfig: () => loadConfigImpl(),
}))

let mdnsPermissionResult: { kind: "granted" | "denied" | "prompt" | "unsupported" } = {
  kind: "granted",
}
jest.mock("@/lib/connectivity/mdns-permission", () => ({
  requestMdnsPermission: async () => mdnsPermissionResult,
}))

const openAppSettingsMock = jest.fn()
jest.mock("@/lib/capacitor/app-settings", () => ({
  openAppSettings: () => openAppSettingsMock(),
}))

let scanLanImpl: (opts: {
  onFound: (s: DiscoveredServer) => void
  paired?: unknown
}) => Promise<void>
jest.mock("@/lib/connectivity/lan-scanner", () => ({
  scanLan: (opts: Parameters<typeof scanLanImpl>[0]) => scanLanImpl(opts),
  rankSource: (s: string) =>
    (({ paired: 4, mdns: 3, probe: 2, history: 1 }) as Record<string, number>)[s] ?? 0,
}))

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) => {
    const map: Record<string, string> = {
      // mobile.connectionState.scan
      title: "Scan local network",
      scanning: "Scanning",
      empty: "No servers yet",
      mdnsDenied: "Local network permission denied",
      openSettings: "Open Settings",
      "fingerprintMismatch.title": "Fingerprint changed",
      "fingerprintMismatch.description": `${(vars?.count as number) ?? 0} server(s) returned a fingerprint that doesn't match the paired record.`,
      "fingerprintMismatch.dismiss": "Dismiss",
      // mobile.pair.discover (ServerCard)
      viaPaired: "Paired",
      viaMdns: "mDNS",
      viaProbe: "Probe",
      viaHistory: "Last used",
      tlsPinned: "TLS pinned",
      tlsMismatch: "Fingerprint changed",
      tlsUnverified: "TLS unverified",
      latencyMs: `${(vars?.ms as number) ?? 0} ms`,
    }
    return map[key] ?? key
  },
}))

function discoveredServer(overrides: Partial<DiscoveredServer>): DiscoveredServer {
  return {
    id: overrides.id ?? `${overrides.ip ?? "192.168.1.5"}:${overrides.port ?? 7890}`,
    ip: "192.168.1.5",
    port: 7890,
    baseUrl: "https://192.168.1.5:7890",
    source: "probe",
    discoveredAt: Date.now(),
    ...overrides,
  } as DiscoveredServer
}

function rowById(id: string): HTMLElement | undefined {
  return screen
    .getAllByTestId("pair-server-card")
    .find((el) => el.getAttribute("data-server-id") === id)
}

beforeEach(() => {
  routerPushMock.mockClear()
  openAppSettingsMock.mockClear()
  loadConfigImpl = () => null
  scanLanImpl = async () => {}
  mdnsPermissionResult = { kind: "granted" }
})

describe("MobileServerScanSheet", () => {
  it("renders empty state when scan returns no servers", async () => {
    render(<MobileServerScanSheet open onOpenChange={() => {}} />)
    await waitFor(() => expect(screen.getByText("No servers yet")).toBeInTheDocument())
  })

  it("threads the active CompanionConfig into scanLan as paired summary", async () => {
    loadConfigImpl = () => ({
      baseUrl: "https://192.168.1.42:7890",
      serverFingerprint: "ABCDEF0123456789",
      deviceId: "d",
      deviceJwt: "j",
      serverVersion: "0.1.0",
    })
    const observedPaired: Array<{ ip: string; port?: number; fingerprint?: string }> = []
    scanLanImpl = async (opts) => {
      for (const p of (opts.paired ?? []) as Array<{
        ip: string
        port?: number
        fingerprint?: string
      }>) {
        observedPaired.push(p)
      }
    }
    render(<MobileServerScanSheet open onOpenChange={() => {}} />)
    await waitFor(() => expect(observedPaired.length).toBeGreaterThan(0))
    expect(observedPaired[0].ip).toBe("192.168.1.42")
    expect(observedPaired[0].port).toBe(7890)
    expect(observedPaired[0].fingerprint).toBe("ABCDEF0123456789")
  })

  it("renders a paired-source row with its source label and port", async () => {
    scanLanImpl = async (opts) => {
      opts.onFound(
        discoveredServer({
          id: "10.0.2.2:7891",
          ip: "10.0.2.2",
          port: 7891,
          baseUrl: "https://10.0.2.2:7891",
          source: "paired",
          fingerprint: "PAIRED-FP",
        })
      )
    }
    render(<MobileServerScanSheet open onOpenChange={() => {}} />)
    const row = await screen.findByTestId("pair-server-card")
    expect(row).toHaveAttribute("data-server-id", "10.0.2.2:7891")
    expect(row).toHaveAttribute("data-source", "paired")
    expect(row).toHaveTextContent("Paired")
    expect(row).toHaveTextContent(":7891")
  })

  it("shows the fingerprint-mismatch banner when paired fp differs from scan fp", async () => {
    loadConfigImpl = () => ({
      baseUrl: "https://192.168.1.42:7890",
      serverFingerprint: "ORIGINAL-FP",
      deviceId: "d",
      deviceJwt: "j",
      serverVersion: "0.1.0",
    })
    scanLanImpl = async (opts) => {
      opts.onFound(
        discoveredServer({
          id: "192.168.1.42:7890",
          ip: "192.168.1.42",
          port: 7890,
          baseUrl: "https://192.168.1.42:7890",
          source: "probe",
          fingerprint: "ROTATED-FP",
        })
      )
    }
    render(<MobileServerScanSheet open onOpenChange={() => {}} />)
    expect(await screen.findByTestId("scan-fingerprint-mismatch-banner")).toBeInTheDocument()
    expect(rowById("192.168.1.42:7890")?.getAttribute("data-mismatch")).toBe("true")
  })

  it("dismiss button hides the banner without forgetting the mismatch on the row", async () => {
    loadConfigImpl = () => ({
      baseUrl: "https://192.168.1.42:7890",
      serverFingerprint: "ORIGINAL-FP",
      deviceId: "d",
      deviceJwt: "j",
      serverVersion: "0.1.0",
    })
    scanLanImpl = async (opts) => {
      opts.onFound(
        discoveredServer({
          id: "192.168.1.42:7890",
          ip: "192.168.1.42",
          port: 7890,
          baseUrl: "https://192.168.1.42:7890",
          source: "probe",
          fingerprint: "ROTATED-FP",
        })
      )
    }
    const user = userEvent.setup()
    render(<MobileServerScanSheet open onOpenChange={() => {}} />)
    await screen.findByTestId("scan-fingerprint-mismatch-banner")
    await user.click(screen.getByTestId("scan-fingerprint-mismatch-dismiss"))
    expect(screen.queryByTestId("scan-fingerprint-mismatch-banner")).toBeNull()
    expect(rowById("192.168.1.42:7890")?.getAttribute("data-mismatch")).toBe("true")
  })

  it("does NOT flag mismatch when the probe didn't supply a fingerprint", async () => {
    loadConfigImpl = () => ({
      baseUrl: "https://192.168.1.42:7890",
      serverFingerprint: "ORIGINAL-FP",
      deviceId: "d",
      deviceJwt: "j",
      serverVersion: "0.1.0",
    })
    scanLanImpl = async (opts) => {
      opts.onFound(
        discoveredServer({
          id: "192.168.1.42:7890",
          ip: "192.168.1.42",
          source: "probe",
          // fingerprint omitted
        })
      )
    }
    render(<MobileServerScanSheet open onOpenChange={() => {}} />)
    await screen.findByTestId("pair-server-card")
    expect(screen.queryByTestId("scan-fingerprint-mismatch-banner")).toBeNull()
  })

  it("permission denied shows openAppSettings CTA", async () => {
    mdnsPermissionResult = { kind: "denied" }
    const user = userEvent.setup()
    render(<MobileServerScanSheet open onOpenChange={() => {}} />)
    const button = await screen.findByTestId("empty-state-cta")
    await user.click(button)
    expect(openAppSettingsMock).toHaveBeenCalled()
  })

  it("clicking a row routes to /pair with baseUrl and fingerprint", async () => {
    const onOpenChange = jest.fn()
    scanLanImpl = async (opts) => {
      opts.onFound(
        discoveredServer({
          id: "192.168.1.5:7890",
          fingerprint: "FP123",
        })
      )
    }
    const user = userEvent.setup()
    render(<MobileServerScanSheet open onOpenChange={onOpenChange} />)
    await user.click(await screen.findByTestId("pair-server-card"))
    expect(routerPushMock).toHaveBeenCalled()
    const url = routerPushMock.mock.calls[0][0] as string
    expect(url).toContain("/pair?")
    expect(url).toContain("baseUrl=")
    expect(url).toContain("fingerprint=FP123")
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})
