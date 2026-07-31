/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"

import { RendezvousCard, displaySignalingUrl } from "./rendezvous-card"
import { useSettingsStore } from "@/stores/settings"
import messages from "@/i18n/messages/en.json"

jest.mock("@/stores/settings", () => ({ useSettingsStore: jest.fn() }))

const useSettingsStoreMock = useSettingsStore as unknown as jest.Mock

function seed(settings: Record<string, unknown> | undefined) {
  useSettingsStoreMock.mockImplementation((selector: (s: { settings: unknown }) => unknown) =>
    selector({ settings })
  )
}

function renderCard() {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <RendezvousCard />
    </NextIntlClientProvider>
  )
}

describe("displaySignalingUrl", () => {
  it("drops the query string so rendezvous ids never reach the screen", () => {
    expect(displaySignalingUrl("wss://sig.example/v2/signaling?rid=abc-123")).toBe(
      "wss://sig.example/v2/signaling"
    )
  })

  it("passes through a value it cannot parse rather than showing nothing", () => {
    expect(displaySignalingUrl("not a url")).toBe("not a url")
  })
})

describe("<RendezvousCard />", () => {
  beforeEach(() => jest.clearAllMocks())

  it("marks the built-in endpoint when the host has not sent one", () => {
    seed({})
    renderCard()
    expect(screen.getByTestId("rendezvous-signaling")).toHaveTextContent("Built-in")
  })

  it("shows a host-supplied signaling server and says where it came from", () => {
    // The regression this card makes visible: a self-hosted signaling server
    // configured on the desktop never reached the phone, and the only symptom
    // was WebRTC failing behind a strict NAT.
    seed({ signalingUrl: "wss://self-hosted.example/v2/signaling" })
    renderCard()

    const row = screen.getByTestId("rendezvous-signaling")
    expect(row).toHaveTextContent("wss://self-hosted.example/v2/signaling")
    expect(row).toHaveTextContent("From host")
  })

  it("counts the STUN and TURN servers that arrived", () => {
    seed({
      iceServers: [{ urls: "stun:a" }, { urls: "stun:b" }],
      turnServers: [{ urls: "turn:c" }],
    })
    renderCard()

    expect(screen.getByTestId("rendezvous-stun")).toHaveTextContent("2 servers")
    expect(screen.getByTestId("rendezvous-turn")).toHaveTextContent("1 server")
  })

  it("says plainly when there is no relay at all", () => {
    seed({ turnServers: [], turnProvider: { kind: "none" } })
    renderCard()

    const row = screen.getByTestId("rendezvous-turn")
    expect(row).toHaveTextContent("none")
    expect(row).toHaveTextContent("No credential provider")
  })

  it("names the credential provider when one is configured", () => {
    seed({ turnProvider: { kind: "cloudflare-calls", cloudflareKeyId: "key-1" } })
    renderCard()
    expect(screen.getByTestId("rendezvous-turn")).toHaveTextContent("Cloudflare Calls")
  })

  it("renders before settings have loaded instead of crashing", () => {
    seed(undefined)
    renderCard()
    expect(screen.getByTestId("rendezvous-signaling")).toHaveTextContent("Built-in")
  })
})
