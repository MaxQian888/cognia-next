/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react"

import { DiscoverStep } from "./discover-step"
import type { DiscoveredServer } from "@/lib/connectivity/lan-scanner"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) => {
    const map: Record<string, string> = {
      title: "Find your desktop",
      subtitle: "Pick a server or use a QR/manual code.",
      scanning: "Scanning your network…",
      rescanCta: "Scan again",
      foundCount: `Found ${(vars?.count as number) ?? 0}`,
      emptyTitle: "No servers found",
      emptyDescription: "Make sure both devices share Wi-Fi.",
      skipToManual: "Use QR or manual entry",
      viaMdns: "mDNS",
      viaProbe: "Probe",
      viaHistory: "Last used",
      tlsPinned: "TLS pinned",
      tlsUnverified: "TLS unverified",
      latencyMs: `${(vars?.ms as number) ?? 0} ms`,
      "localNetwork.title": "Local network blocked",
      "localNetwork.description": "Open Settings and grant Local Network access.",
      "localNetwork.openSettings": "Open Settings",
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

describe("<DiscoverStep />", () => {
  it("starts a scan immediately on mount and surfaces hits", async () => {
    const scan = makeScanStub({ hits: [mdnsHit] })
    render(<DiscoverStep onSelect={() => {}} onSkip={() => {}} scan={scan as never} />)
    await waitFor(() => expect(scan).toHaveBeenCalledTimes(1))
    expect(await screen.findByTestId("pair-server-card")).toBeInTheDocument()
    expect(screen.getByText("cognia-AB12.local")).toBeInTheDocument()
  })

  it("orders mDNS hits ahead of probe hits", async () => {
    const scan = makeScanStub({ hits: [probeHit, mdnsHit] })
    render(<DiscoverStep onSelect={() => {}} onSkip={() => {}} scan={scan as never} />)
    await waitFor(() => expect(screen.getAllByTestId("pair-server-card")).toHaveLength(2))
    const cards = screen.getAllByTestId("pair-server-card")
    expect(cards[0]).toHaveAttribute("data-source", "mdns")
    expect(cards[1]).toHaveAttribute("data-source", "probe")
  })

  it("forwards onSelect with the picked server", async () => {
    const onSelect = jest.fn()
    const scan = makeScanStub({ hits: [mdnsHit] })
    render(<DiscoverStep onSelect={onSelect} onSkip={() => {}} scan={scan as never} />)
    fireEvent.click(await screen.findByTestId("pair-server-card"))
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: mdnsHit.id }))
  })

  it("renders an empty state once the scan settles with no results", async () => {
    const scan = makeScanStub({ hits: [] })
    render(<DiscoverStep onSelect={() => {}} onSkip={() => {}} scan={scan as never} />)
    await waitFor(() => expect(screen.getByTestId("pair-discover-empty")).toBeInTheDocument())
  })

  it("skip button calls onSkip", async () => {
    const onSkip = jest.fn()
    const scan = makeScanStub({ hits: [] })
    render(<DiscoverStep onSelect={() => {}} onSkip={onSkip} scan={scan as never} />)
    fireEvent.click(screen.getByTestId("pair-discover-skip"))
    expect(onSkip).toHaveBeenCalled()
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

  it("seeds the list with history entries when no scan results have arrived yet", async () => {
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
    expect(await screen.findByTestId("pair-server-card")).toHaveAttribute("data-source", "history")
  })
})
