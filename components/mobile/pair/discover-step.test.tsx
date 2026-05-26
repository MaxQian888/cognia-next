/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react"

import { DiscoverStep } from "./discover-step"
import type { DiscoveredServer } from "@/lib/connectivity/lan-scanner"
import type { HealthzResult } from "@/lib/connectivity/healthz"

jest.mock("@/lib/capacitor/haptics", () => ({
  impact: jest.fn(async () => ({ kind: "unsupported" })),
  notify: jest.fn(async () => ({ kind: "unsupported" })),
}))

jest.mock("@/lib/capacitor/browser", () => ({
  open: jest.fn(async () => ({ kind: "ok" })),
}))

jest.mock("@/lib/capacitor/app-settings", () => ({
  openAppSettings: jest.fn(async () => ({ kind: "ok" })),
}))

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) => {
    const map: Record<string, string> = {
      title: "Find your desktop",
      subtitle: "Pick a server or use a QR/manual code.",
      scanning: "Scanning your network…",
      rescanCta: "Scan again",
      scanQrCta: "Scan QR code",
      recentTitle: "Recent",
      nearbyTitle: "On this network",
      foundCount: `Found ${(vars?.count as number) ?? 0}`,
      emptyTitle: "No servers found",
      emptyDescription: "Make sure both devices share Wi-Fi.",
      skipToManual: "Enter manually",
      precheckUnreachable: "Couldn't reach this server",
      precheckOk: `Reachable · v${vars?.version} · ${vars?.ms}ms`,
      viaPaired: "Paired",
      viaMdns: "mDNS",
      viaProbe: "Probe",
      viaHistory: "Last used",
      tlsPinned: "TLS pinned",
      tlsMismatch: "Fingerprint changed",
      tlsUnverified: "TLS unverified",
      latencyMs: `${(vars?.ms as number) ?? 0} ms`,
      "localNetwork.title": "Local network blocked",
      "localNetwork.description": "Open Settings and grant Local Network access.",
      "help.trigger": "Can't find your desktop?",
      "help.tipSameNetwork": "Same Wi-Fi",
      "help.tipFirewall": "Firewall",
      "help.tipEnableServer": "Companion on",
      "help.docsCta": "Read the guide",
      "help.openSettings": "Open Settings",
    }
    return map[key] ?? key
  },
}))

const mdnsHit: DiscoveredServer = {
  id: "192.168.1.42:7890",
  hostname: "cognia-AB12.local",
  ip: "192.168.1.42",
  port: 7890,
  baseUrl: "https://cognia-AB12.local:7890",
  source: "mdns",
  fingerprint: "ABCD1234",
  serverVersion: "0.4.2",
  discoveredAt: 0,
}

const probeHit: DiscoveredServer = {
  id: "192.168.1.99:7890",
  ip: "192.168.1.99",
  port: 7890,
  baseUrl: "http://192.168.1.99:7890",
  source: "probe",
  latencyMs: 32,
  discoveredAt: 0,
}

const healthzOk: HealthzResult = {
  version: "0.4.2",
  fingerprint: "HZ-FP",
  advertisedPort: 7890,
  serverId: "srv-1",
}

function makeScanStub({
  hits = [],
  rejectsWith,
}: {
  hits?: DiscoveredServer[]
  rejectsWith?: Error
} = {}) {
  return jest.fn(async ({ onFound }: { onFound: (s: DiscoveredServer) => void }) => {
    if (rejectsWith) throw rejectsWith
    for (const h of hits) onFound(h)
    return hits
  })
}

const probeOk = jest.fn(async () => healthzOk)
const probeFail = jest.fn(async () => null)

beforeEach(() => {
  probeOk.mockClear()
  probeFail.mockClear()
})

describe("<DiscoverStep />", () => {
  it("starts a scan immediately on mount and surfaces hits", async () => {
    const scan = makeScanStub({ hits: [mdnsHit] })
    render(<DiscoverStep onSelect={() => {}} onSkip={() => {}} scan={scan as never} />)
    await waitFor(() => expect(scan).toHaveBeenCalledTimes(1))
    expect(await screen.findByTestId("pair-server-card")).toBeInTheDocument()
    expect(screen.getByText("cognia-AB12.local")).toBeInTheDocument()
  })

  it("orders mDNS hits ahead of probe hits in the nearby group", async () => {
    const scan = makeScanStub({ hits: [probeHit, mdnsHit] })
    render(<DiscoverStep onSelect={() => {}} onSkip={() => {}} scan={scan as never} />)
    await waitFor(() => expect(screen.getAllByTestId("pair-server-card")).toHaveLength(2))
    const cards = screen.getAllByTestId("pair-server-card")
    expect(cards[0]).toHaveAttribute("data-source", "mdns")
    expect(cards[1]).toHaveAttribute("data-source", "probe")
  })

  it("pre-flights /healthz then forwards onSelect with an enriched server", async () => {
    const onSelect = jest.fn()
    const scan = makeScanStub({ hits: [probeHit] })
    render(
      <DiscoverStep
        onSelect={onSelect}
        onSkip={() => {}}
        scan={scan as never}
        probe={probeOk as never}
        precheckDelayMs={0}
      />
    )
    fireEvent.click(await screen.findByTestId("pair-server-card"))
    await waitFor(() => expect(onSelect).toHaveBeenCalled())
    expect(probeOk).toHaveBeenCalled()
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ id: probeHit.id, fingerprint: "HZ-FP", serverVersion: "0.4.2" })
    )
  })

  it("shows an inline error and does NOT advance when the pre-flight fails", async () => {
    const onSelect = jest.fn()
    const scan = makeScanStub({ hits: [probeHit] })
    render(
      <DiscoverStep
        onSelect={onSelect}
        onSkip={() => {}}
        scan={scan as never}
        probe={probeFail as never}
        precheckDelayMs={0}
      />
    )
    fireEvent.click(await screen.findByTestId("pair-server-card"))
    await waitFor(() =>
      expect(screen.getByTestId("pair-server-card-status")).toHaveTextContent(
        "Couldn't reach this server"
      )
    )
    expect(onSelect).not.toHaveBeenCalled()
  })

  it("renders an empty state once the scan settles with no results", async () => {
    const scan = makeScanStub({ hits: [] })
    render(<DiscoverStep onSelect={() => {}} onSkip={() => {}} scan={scan as never} />)
    await waitFor(() => expect(screen.getByTestId("empty-state")).toBeInTheDocument())
  })

  it("groups history entries under the Recent heading", async () => {
    const history: DiscoveredServer[] = [
      {
        id: "192.168.0.1:7890",
        ip: "192.168.0.1",
        port: 7890,
        baseUrl: "http://192.168.0.1:7890",
        source: "history",
        discoveredAt: 0,
      },
    ]
    const scan = makeScanStub({ hits: [] })
    render(
      <DiscoverStep history={history} onSelect={() => {}} onSkip={() => {}} scan={scan as never} />
    )
    const recent = await screen.findByTestId("pair-discover-recent")
    expect(recent).toHaveTextContent("Recent")
    expect(recent.querySelector('[data-source="history"]')).not.toBeNull()
  })

  it("skip button calls onSkip", async () => {
    const onSkip = jest.fn()
    const scan = makeScanStub({ hits: [] })
    render(<DiscoverStep onSelect={() => {}} onSkip={onSkip} scan={scan as never} />)
    fireEvent.click(screen.getByTestId("pair-discover-skip"))
    expect(onSkip).toHaveBeenCalled()
  })

  it("scan-QR button calls onScanShortcut", async () => {
    const onScanShortcut = jest.fn()
    const scan = makeScanStub({ hits: [] })
    render(
      <DiscoverStep
        onSelect={() => {}}
        onSkip={() => {}}
        onScanShortcut={onScanShortcut}
        scan={scan as never}
      />
    )
    fireEvent.click(screen.getByTestId("pair-discover-scan-qr"))
    expect(onScanShortcut).toHaveBeenCalled()
  })

  it("rescan triggers a fresh scan call", async () => {
    const scan = makeScanStub({ hits: [] })
    render(<DiscoverStep onSelect={() => {}} onSkip={() => {}} scan={scan as never} />)
    await waitFor(() => expect(scan).toHaveBeenCalledTimes(1))
    fireEvent.click(await screen.findByTestId("pair-discover-rescan"))
    await waitFor(() => expect(scan).toHaveBeenCalledTimes(2))
  })

  it("shows a permission alert when scan rejects with a permission error", async () => {
    const scan = makeScanStub({ rejectsWith: new Error("permission denied") })
    render(<DiscoverStep onSelect={() => {}} onSkip={() => {}} scan={scan as never} />)
    expect(await screen.findByTestId("pair-discover-permission")).toBeInTheDocument()
  })
})
