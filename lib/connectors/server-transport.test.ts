/**
 * @jest-environment node
 */

import {
  CONNECTORS_SERVER_PORT,
  HEADLESS_CONNECTORS_PREFIX,
  adapterNeedsInboundServer,
  connectorWebhookPath,
  LARK_OAUTH_RELAY_PATH,
  connectorOAuthRelayPath,
  resolveConnectorsIngressBase,
} from "./server-transport"
import type { TransportMode } from "@/types/connectors/adapter"

function adapter(modes: TransportMode[]) {
  return { meta: { transportModes: modes } } as unknown as Parameters<
    typeof adapterNeedsInboundServer
  >[0]
}
function row(transportMode: TransportMode) {
  return { transportMode } as Parameters<typeof adapterNeedsInboundServer>[1]
}

describe("CONNECTORS_SERVER_PORT", () => {
  it("is the shared loopback port", () => {
    expect(CONNECTORS_SERVER_PORT).toBe(7842)
  })
})

describe("adapterNeedsInboundServer", () => {
  it.each<[string, TransportMode[], TransportMode, boolean]>([
    // Webhook transports need the axum receiver.
    ["lark webhook", ["webhook"], "webhook", true],
    ["lark long-connection (gateway)", ["gateway"], "gateway", false],
    ["slack events-api webhook", ["webhook"], "webhook", true],
    ["slack socket-mode (forward-ws)", ["forward-ws"], "forward-ws", false],
    ["telegram webhook", ["webhook"], "webhook", true],
    ["telegram longpoll", ["longpoll"], "longpoll", false],
    ["wechat-oa webhook", ["webhook"], "webhook", true],
    // OneBot narrows to BOTH ws modes; the row disambiguates.
    ["onebot reverse-ws", ["reverse-ws", "forward-ws"], "reverse-ws", true],
    ["onebot forward-ws", ["reverse-ws", "forward-ws"], "forward-ws", false],
    // Discord is dual-mode (gateway + webhook); the row disambiguates.
    ["discord gateway", ["gateway", "webhook"], "gateway", false],
    ["discord webhook", ["gateway", "webhook"], "webhook", true],
    // Pure outbound transports never need the server.
    ["wecom gateway", ["gateway"], "gateway", false],
    ["qq-official gateway", ["gateway"], "gateway", false],
    ["dingtalk gateway", ["gateway"], "gateway", false],
    ["matrix longpoll", ["longpoll"], "longpoll", false],
  ])("%s → %s", (_label, modes, transportMode, expected) => {
    expect(adapterNeedsInboundServer(adapter(modes), row(transportMode))).toBe(expected)
  })
})

describe("connectorWebhookPath", () => {
  it("matches the Rust route shape `/webhook/{type}/{id}`", () => {
    expect(connectorWebhookPath("lark", "adp_1")).toBe("/webhook/lark/adp_1")
  })
})

describe("resolveConnectorsIngressBase", () => {
  it("uses the cloudflared tunnel on the desktop", () => {
    expect(
      resolveConnectorsIngressBase({ isDesktop: true, tunnelUrl: "https://t.example.com" })
    ).toBe("https://t.example.com")
  })

  it("returns null on the desktop when no tunnel is running", () => {
    // A real state, not a misconfiguration: nothing is publicly reachable yet.
    expect(resolveConnectorsIngressBase({ isDesktop: true, tunnelUrl: null })).toBeNull()
    expect(resolveConnectorsIngressBase({ isDesktop: true, tunnelUrl: "  " })).toBeNull()
  })

  it("nests under /connectors on a cloud host", () => {
    // The headless companion mounts the connectors router under a prefix; the
    // desktop serves it standalone. Deriving one from the other 404s.
    expect(
      resolveConnectorsIngressBase({ isDesktop: false, publicBase: "https://app.example.com" })
    ).toBe(`https://app.example.com${HEADLESS_CONNECTORS_PREFIX}`)
  })

  it("strips trailing slashes from either source", () => {
    expect(
      resolveConnectorsIngressBase({ isDesktop: true, tunnelUrl: "https://t.example.com//" })
    ).toBe("https://t.example.com")
    expect(
      resolveConnectorsIngressBase({ isDesktop: false, publicBase: "https://app.example.com/" })
    ).toBe(`https://app.example.com${HEADLESS_CONNECTORS_PREFIX}`)
  })

  it("ignores the tunnel on a cloud host, and the origin on the desktop", () => {
    expect(
      resolveConnectorsIngressBase({
        isDesktop: false,
        tunnelUrl: "https://t.example.com",
        publicBase: "https://app.example.com",
      })
    ).toBe(`https://app.example.com${HEADLESS_CONNECTORS_PREFIX}`)
    expect(
      resolveConnectorsIngressBase({
        isDesktop: true,
        tunnelUrl: "https://t.example.com",
        publicBase: "https://app.example.com",
      })
    ).toBe("https://t.example.com")
  })

  it("returns null on a cloud host with no configured origin", () => {
    expect(resolveConnectorsIngressBase({ isDesktop: false })).toBeNull()
    expect(resolveConnectorsIngressBase({ isDesktop: false, publicBase: "" })).toBeNull()
  })
})

describe("connectorOAuthRelayPath", () => {
  it("keeps Lark on its own path", () => {
    // That exact path is registered byte-for-byte in every existing install's
    // Feishu console; moving it onto the generic route would break them.
    expect(connectorOAuthRelayPath("lark")).toBe(LARK_OAUTH_RELAY_PATH)
  })

  it("puts every other platform on the generic connector relay", () => {
    expect(connectorOAuthRelayPath("slack")).toBe("/oauth/connector/slack/callback")
  })

  it("is what the brain prefixes with the ingress base on either host", () => {
    const desktop = resolveConnectorsIngressBase({
      isDesktop: true,
      tunnelUrl: "https://t.example",
    })
    const headless = resolveConnectorsIngressBase({
      isDesktop: false,
      publicBase: "https://cognia.example",
    })
    expect(`${desktop}${connectorOAuthRelayPath("slack")}`).toBe(
      "https://t.example/oauth/connector/slack/callback"
    )
    expect(`${headless}${connectorOAuthRelayPath("slack")}`).toBe(
      "https://cognia.example/connectors/oauth/connector/slack/callback"
    )
  })
})
