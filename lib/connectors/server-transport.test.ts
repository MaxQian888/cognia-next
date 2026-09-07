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
function row(transportMode: TransportMode | undefined) {
  return { transportMode } as Parameters<typeof adapterNeedsInboundServer>[1]
}

describe("CONNECTORS_SERVER_PORT", () => {
  it("is the shared loopback port", () => {
    expect(CONNECTORS_SERVER_PORT).toBe(7842)
  })
})

describe("adapterNeedsInboundServer", () => {
  it.each<[string, TransportMode[], TransportMode | undefined, boolean]>([
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
    // A single declared transport is unambiguous, so the row cannot contradict
    // it. wechat-oa speaks webhook and nothing else: a row that reads as any
    // other mode still needs the receiver, or the adapter has no way to hear
    // anything at all. Both of these used to return false.
    ["wechat-oa, row has no transportMode", ["webhook"], undefined, true],
    ["wechat-oa, row drifted to longpoll", ["webhook"], "longpoll", true],
    // lark and slack declare ONE mode computed from `settings.transport`, a
    // different persisted field from `row.transportMode`. When they disagree
    // the declaration wins, in both directions.
    ["lark built as gateway, row says webhook", ["gateway"], "webhook", false],
    ["lark built as webhook, row says gateway", ["webhook"], "gateway", true],
    // Genuinely dual-mode adapters have nothing to fall back to, so the row
    // stays the only disambiguator and an unset one is not guessed at.
    ["discord, row has no transportMode", ["gateway", "webhook"], undefined, false],
    ["qq-official, row has no transportMode", ["gateway", "webhook"], undefined, false],
    // OneBot keeps its defensive default: reverse-ws is the mode that needs a
    // listener, and only an explicit forward-ws opts out.
    ["onebot, row has no transportMode", ["reverse-ws", "forward-ws"], undefined, true],
  ])("%s → %s", (_label, modes, transportMode, expected) => {
    expect(adapterNeedsInboundServer(adapter(modes), row(transportMode))).toBe(expected)
  })

  it("treats a null transportMode the same as an absent one", () => {
    // Dexie hands back whatever was written. The interface says required, but
    // this predicate is the one place a wrong answer silently starves a bot.
    expect(
      adapterNeedsInboundServer(adapter(["webhook"]), {
        transportMode: null,
      })
    ).toBe(true)
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
