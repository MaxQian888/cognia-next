/**
 * @jest-environment node
 */

import { CONNECTORS_SERVER_PORT, adapterNeedsInboundServer } from "./server-transport"
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
    // Pure outbound transports never need the server.
    ["discord gateway", ["gateway"], "gateway", false],
    ["wecom gateway", ["gateway"], "gateway", false],
    ["qq-official gateway", ["gateway"], "gateway", false],
    ["dingtalk gateway", ["gateway"], "gateway", false],
    ["matrix longpoll", ["longpoll"], "longpoll", false],
  ])("%s → %s", (_label, modes, transportMode, expected) => {
    expect(adapterNeedsInboundServer(adapter(modes), row(transportMode))).toBe(expected)
  })
})
