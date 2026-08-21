/**
 * @jest-environment jsdom
 */
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

// Interpolation is echoed into the rendered string so the address assertions
// below can check *which* URL each banner names, not just that one rendered.
jest.mock("next-intl", () => ({
  useTranslations: (ns: string) => (key: string, values?: Record<string, unknown>) =>
    values ? `${ns}.${key}:${JSON.stringify(values)}` : `${ns}.${key}`,
}))

import { decodePairPayload, encodePairPayload, type PairPayload } from "@/lib/qr/pair-payload"
import type { BrowsedHost } from "@/lib/connectivity/mdns-browse"
import { LanDiscoveryPanel } from "./lan-discovery-panel"

const FINGERPRINT = "abc123"

function makePayload(overrides: Partial<PairPayload> = {}): string {
  return encodePairPayload({
    baseUrl: "https://192.168.1.9:27890",
    mode: "owner-invitation",
    invitation: "invite-token",
    hostId: "host-1",
    tenantId: "local_acct_a",
    expiresAt: Date.now() + 600_000,
    serverVersion: "1.2.3",
    fingerprint: FINGERPRINT,
    ...overrides,
  })
}

function makeHost(overrides: Partial<BrowsedHost> = {}): BrowsedHost {
  return {
    fullname: "cognia-ab12cd._cognia._tcp.local.",
    instanceName: "cognia-ab12cd",
    hostname: "cognia-ab12cd.local.",
    addresses: ["192.168.1.9"],
    port: 27890,
    appVersion: "1.2.3",
    tlsFingerprint: FINGERPRINT,
    baseUrl: "https://192.168.1.9:27890",
    isSelf: false,
    ...overrides,
  }
}

function browseReturning(hosts: BrowsedHost[]) {
  return jest.fn(async () => hosts)
}

describe("LanDiscoveryPanel", () => {
  it("lists the hosts a sweep finds and flags this machine", async () => {
    const user = userEvent.setup()
    const browse = browseReturning([
      makeHost(),
      makeHost({
        fullname: "cognia-self._cognia._tcp.local.",
        instanceName: "cognia-self",
        isSelf: true,
        baseUrl: "https://192.168.1.4:27890",
        tlsFingerprint: "self-fp",
      }),
    ])

    render(<LanDiscoveryPanel payload="" onUseAddress={jest.fn()} browse={browse} />)
    await user.click(screen.getByRole("button", { name: /scan/i }))

    await waitFor(() => expect(screen.getAllByTestId("lan-discovery-host")).toHaveLength(2))
    expect(screen.getByText("cognia-ab12cd")).toBeInTheDocument()
    expect(screen.getByText("https://192.168.1.4:27890")).toBeInTheDocument()
    // Own advertisement stays in the list, labelled — filtering it out would
    // leave the user wondering why their machine is missing.
    expect(screen.getByText("settings.remoteHosts.add.discover.self")).toBeInTheDocument()
    expect(browse).toHaveBeenCalledWith({ timeoutMs: 2500 })
  })

  it("shows the empty state only after a sweep has run", async () => {
    const user = userEvent.setup()
    const browse = browseReturning([])

    render(<LanDiscoveryPanel payload="" onUseAddress={jest.fn()} browse={browse} />)
    expect(screen.queryByText("settings.remoteHosts.add.discover.empty")).not.toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: /scan/i }))

    await waitFor(() =>
      expect(screen.getByText("settings.remoteHosts.add.discover.empty")).toBeInTheDocument()
    )
  })

  it("says nothing about a pasted invitation until a sweep has run", () => {
    // Before a scan, "this host isn't advertising" would only mean "we never
    // looked" — a claim the panel has not earned yet.
    render(
      <LanDiscoveryPanel payload={makePayload()} onUseAddress={jest.fn()} browse={jest.fn()} />
    )

    expect(screen.queryByTestId("lan-discovery-match")).not.toBeInTheDocument()
    expect(screen.queryByTestId("lan-discovery-not-advertising")).not.toBeInTheDocument()
  })

  it("confirms an invitation that already points at the live address", async () => {
    const user = userEvent.setup()

    render(
      <LanDiscoveryPanel
        payload={makePayload()}
        onUseAddress={jest.fn()}
        browse={browseReturning([makeHost()])}
      />
    )
    await user.click(screen.getByRole("button", { name: /scan/i }))

    const note = await screen.findByTestId("lan-discovery-match")
    expect(note).toHaveTextContent("https://192.168.1.9:27890")
  })

  it("reports a host that is not advertising, without blocking pairing", async () => {
    const user = userEvent.setup()

    render(
      <LanDiscoveryPanel
        payload={makePayload()}
        onUseAddress={jest.fn()}
        browse={browseReturning([makeHost({ tlsFingerprint: "someone-else" })])}
      />
    )
    await user.click(screen.getByRole("button", { name: /scan/i }))

    // Informational: the host may be reachable over a tunnel instead.
    expect(await screen.findByTestId("lan-discovery-not-advertising")).toBeInTheDocument()
  })

  it("rewrites a stale invitation address to the live one, keeping the pin", async () => {
    const user = userEvent.setup()
    const onUseAddress = jest.fn()
    const moved = makeHost({
      addresses: ["192.168.1.22"],
      baseUrl: "https://192.168.1.22:27890",
    })

    render(
      <LanDiscoveryPanel
        payload={makePayload()}
        onUseAddress={onUseAddress}
        browse={browseReturning([moved])}
      />
    )
    await user.click(screen.getByRole("button", { name: /scan/i }))

    const stale = await screen.findByTestId("lan-discovery-stale")
    expect(stale).toHaveTextContent("https://192.168.1.9:27890")
    expect(stale).toHaveTextContent("https://192.168.1.22:27890")

    await user.click(screen.getByRole("button", { name: /useAddress/i }))

    expect(onUseAddress).toHaveBeenCalledTimes(1)
    const rewritten = decodePairPayload(onUseAddress.mock.calls[0][0] as string)
    expect(rewritten.kind).toBe("ok")
    if (rewritten.kind !== "ok") throw new Error("expected a decodable payload")
    expect(rewritten.payload.baseUrl).toBe("https://192.168.1.22:27890")
    // The rewrite is only safe because the fingerprint matched — it must
    // survive untouched, along with the invitation the host issued.
    expect(rewritten.payload.fingerprint).toBe(FINGERPRINT)
    expect(rewritten.payload.invitation).toBe("invite-token")
    expect(rewritten.payload.hostId).toBe("host-1")
  })

  it("ignores an unparseable payload instead of cross-checking it", async () => {
    const user = userEvent.setup()

    render(
      <LanDiscoveryPanel
        payload="not-a-payload"
        onUseAddress={jest.fn()}
        browse={browseReturning([makeHost()])}
      />
    )
    await user.click(screen.getByRole("button", { name: /scan/i }))

    await waitFor(() => expect(screen.getAllByTestId("lan-discovery-host")).toHaveLength(1))
    expect(screen.queryByTestId("lan-discovery-match")).not.toBeInTheDocument()
    expect(screen.queryByTestId("lan-discovery-not-advertising")).not.toBeInTheDocument()
  })
})
