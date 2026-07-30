/**
 * @jest-environment jsdom
 */
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"

import { ChannelMatrixCard, type ChannelMatrixDeps } from "./channel-matrix-card"
import { useSettingsStore } from "@/stores/settings"
import messages from "@/i18n/messages/en.json"

jest.mock("@/stores/settings", () => ({ useSettingsStore: jest.fn() }))
jest.mock("sonner", () => ({ toast: { error: jest.fn() } }))

import { toast } from "sonner"

const useSettingsStoreMock = useSettingsStore as unknown as jest.Mock

function seedSettings(settings: Record<string, unknown>) {
  useSettingsStoreMock.mockImplementation((selector: (s: { settings: unknown }) => unknown) =>
    selector({ settings })
  )
}

function renderCard(deps: ChannelMatrixDeps = {}) {
  const merged: ChannelMatrixDeps = {
    isDesktop: () => true,
    fetchServerStatus: async () => ({ running: true, bindMode: "lan", boundPort: 27890 }),
    fetchMdnsOn: async () => false,
    fetchTunnelUrl: async () => null,
    probeReachability: async () => [],
    ...deps,
  }
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <ChannelMatrixCard {...merged} />
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  jest.clearAllMocks()
  seedSettings({})
})

describe("<ChannelMatrixCard />", () => {
  it("renders every channel so a missing one is visible rather than absent", async () => {
    renderCard()
    for (const id of ["lan", "mdns", "tunnel", "webrtc"]) {
      expect(await screen.findByTestId(`channel-row-${id}`)).toBeInTheDocument()
    }
  })

  it("reports the desktop as reachable once a channel is live", async () => {
    renderCard()
    await waitFor(() =>
      expect(screen.getByTestId("channel-matrix-summary")).toHaveTextContent("Reachable")
    )
  })

  it("calls out a server that is up but bound to loopback", async () => {
    // The old layout buried this in a warning paragraph on the server card, so
    // "running" and "unreachable from my phone" looked like a contradiction.
    renderCard({
      fetchServerStatus: async () => ({ running: true, bindMode: "loopback", boundPort: 27890 }),
    })
    await waitFor(() =>
      expect(screen.getByTestId("channel-row-lan")).toHaveTextContent("Bound to this machine only")
    )
    expect(screen.getByTestId("channel-matrix-summary")).toHaveTextContent(
      "Nothing can reach this desktop"
    )
  })

  it("shows a live tunnel and its public URL", async () => {
    renderCard({ fetchTunnelUrl: async () => "https://x.trycloudflare.com" })
    await waitFor(() =>
      expect(screen.getByTestId("channel-row-tunnel")).toHaveTextContent(
        "https://x.trycloudflare.com"
      )
    )
  })

  it("flags WebRTC that is switched on with nowhere to rendezvous", async () => {
    seedSettings({ webrtcEnabled: true, signalingUrl: undefined })
    renderCard()
    await waitFor(() =>
      expect(screen.getByTestId("channel-row-webrtc")).toHaveTextContent(
        "No rendezvous server configured"
      )
    )
  })

  it("folds probe results into the matching channel row", async () => {
    const user = userEvent.setup()
    renderCard({
      probeReachability: async () => [
        { url: "https://192.168.1.42:27890", reachable: true, latencyMs: 6 },
      ],
    })
    await user.click(await screen.findByTestId("channel-matrix-probe"))
    await waitFor(() =>
      expect(screen.getByTestId("channel-row-lan")).toHaveTextContent("Reachable in 6 ms")
    )
  })

  it("surfaces a failing probe against the channel it belongs to", async () => {
    const user = userEvent.setup()
    renderCard({
      probeReachability: async () => [
        { url: "https://192.168.1.42:27890", reachable: false, error: "timeout" },
      ],
    })
    await user.click(await screen.findByTestId("channel-matrix-probe"))
    await waitFor(() =>
      expect(screen.getByTestId("channel-row-lan")).toHaveTextContent("Unreachable — timeout")
    )
  })

  it("reports a probe that throws instead of leaving the button spinning", async () => {
    const user = userEvent.setup()
    renderCard({
      probeReachability: async () => {
        throw new Error("no host")
      },
    })
    const button = await screen.findByTestId("channel-matrix-probe")
    await user.click(button)
    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    expect(button).not.toBeDisabled()
  })

  it("disables the probe and says why when not on the desktop", async () => {
    renderCard({ isDesktop: () => false })
    expect(await screen.findByTestId("channel-matrix-probe")).toBeDisabled()
    expect(screen.getByText(/only be tested from the desktop app/)).toBeInTheDocument()
  })

  it("survives a status read that rejects", async () => {
    renderCard({
      fetchServerStatus: async () => {
        throw new Error("ipc down")
      },
    })
    // Falls back to "stopped", which is the honest reading of "cannot tell".
    await waitFor(() =>
      expect(screen.getByTestId("channel-row-lan")).toHaveTextContent(
        "The companion server is not running"
      )
    )
  })
})
