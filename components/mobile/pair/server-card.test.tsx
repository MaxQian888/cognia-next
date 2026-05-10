/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen } from "@testing-library/react"

import { ServerCard } from "./server-card"
import type { DiscoveredServer } from "@/lib/connectivity/lan-scanner"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) => {
    const map: Record<string, string> = {
      viaMdns: "mDNS",
      viaProbe: "Probe",
      viaHistory: "Last used",
      tlsPinned: "TLS pinned",
      tlsUnverified: "TLS unverified",
      latencyMs: `${(vars?.ms as number) ?? 0} ms`,
    }
    return map[key] ?? key
  },
}))

const baseServer: DiscoveredServer = {
  id: "192.168.1.42:7890",
  hostname: "cognia-AB12.local",
  ip: "192.168.1.42",
  port: 7890,
  baseUrl: "https://cognia-AB12.local:7890",
  source: "mdns",
  fingerprint: "AAAA1111BBBB2222",
  serverVersion: "0.4.2",
  latencyMs: 12,
  discoveredAt: 0,
}

describe("<ServerCard />", () => {
  it("renders mDNS hits with the TLS-pinned badge", () => {
    render(<ServerCard server={baseServer} onSelect={() => {}} />)
    expect(screen.getByText("cognia-AB12.local")).toBeInTheDocument()
    expect(screen.getByText("TLS pinned")).toBeInTheDocument()
    expect(screen.getByText("mDNS")).toBeInTheDocument()
    expect(screen.getByText("v0.4.2")).toBeInTheDocument()
    expect(screen.getByText("12 ms")).toBeInTheDocument()
    expect(screen.getByTestId("pair-server-card")).toHaveAttribute("data-source", "mdns")
  })

  it("warns on probe hits with no TLS pin", () => {
    render(
      <ServerCard
        server={{
          ...baseServer,
          source: "probe",
          fingerprint: undefined,
          hostname: undefined,
          serverVersion: undefined,
        }}
        onSelect={() => {}}
      />
    )
    expect(screen.queryByText("TLS pinned")).not.toBeInTheDocument()
    expect(screen.getByText("TLS unverified")).toBeInTheDocument()
    expect(screen.getByText("Probe")).toBeInTheDocument()
    expect(screen.getByTestId("pair-server-card")).toHaveAttribute("data-source", "probe")
  })

  it("renders a history entry with its dedicated icon and label", () => {
    render(
      <ServerCard
        server={{ ...baseServer, source: "history", fingerprint: undefined, latencyMs: undefined }}
        onSelect={() => {}}
      />
    )
    expect(screen.getByText("Last used")).toBeInTheDocument()
    expect(screen.getByTestId("pair-server-card")).toHaveAttribute("data-source", "history")
  })

  it("calls onSelect with the server when tapped", () => {
    const onSelect = jest.fn()
    render(<ServerCard server={baseServer} onSelect={onSelect} />)
    fireEvent.click(screen.getByTestId("pair-server-card"))
    expect(onSelect).toHaveBeenCalledWith(baseServer)
  })

  it("reflects a selected state via aria-pressed", () => {
    render(<ServerCard server={baseServer} onSelect={() => {}} selected />)
    const node = screen.getByTestId("pair-server-card")
    expect(node).toHaveAttribute("aria-pressed", "true")
    expect(node).toHaveAttribute("data-selected", "true")
  })
})
