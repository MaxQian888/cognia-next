/**
 * Golden-fixture parity for the bridge WS protocol (ADR-0059 T-B1). The
 * same file is asserted by the Rust side (`ws_bridge.rs` `include_str!`),
 * so a drift on either side fails that side's suite.
 *
 * @jest-environment node
 */
import fixtures from "./fixtures/bridge-frames.json"
import { HEADLESS_CATALOG_HASH, HEADLESS_CONTRACT_VERSION } from "./headless-contract-identity"
import {
  BRIDGE_PROTOCOL_VERSION,
  buildHello,
  buildPong,
  buildRespond,
  buildWorkerFrame,
  parseBridgeFrame,
  serializeBridgeFrame,
  type BridgeFrame,
} from "./protocol"

describe("bridge protocol golden fixtures", () => {
  it("matches the protocol version", () => {
    expect(fixtures.protocol).toBe(BRIDGE_PROTOCOL_VERSION)
    expect(fixtures.frames.hello.catalogHash).toBe(HEADLESS_CATALOG_HASH)
    expect(fixtures.frames.hello.contractVersion).toBe(HEADLESS_CONTRACT_VERSION)
    expect(fixtures.frames.helloAck.catalogHash).toBe(HEADLESS_CATALOG_HASH)
    expect(fixtures.frames.helloAck.contractVersion).toBe(HEADLESS_CONTRACT_VERSION)
  })

  it("every fixture frame parses and roundtrips byte-identically", () => {
    const frames = fixtures.frames as Record<string, unknown>
    expect(Object.keys(frames).length).toBeGreaterThan(0)
    for (const [name, value] of Object.entries(frames)) {
      const text = JSON.stringify(value)
      const parsed = parseBridgeFrame(text)
      expect(parsed).not.toBeNull()
      expect(JSON.parse(serializeBridgeFrame(parsed as BridgeFrame))).toEqual(value)
      void name
    }
  })

  it("builders reproduce the fixture shapes", () => {
    const hello = buildHello({
      brainVersion: "0.1.0",
      accountId: "local_acct_a",
    })
    expect(hello).toEqual(fixtures.frames.hello)

    const respond = buildRespond("companion_sync_pull_response", {
      requestId: "11111111-1111-4111-8111-111111111111",
      delta: { rows: [], deleted_ids: [], next_since: 0 },
      error: null,
    })
    expect(respond).toEqual(fixtures.frames.respondSyncPull)

    const pong = buildPong(1751400000000, 123456789, 1751399990000)
    expect(pong).toEqual(fixtures.frames.pong)
  })

  it("rejects malformed and unknown frames without throwing", () => {
    expect(parseBridgeFrame("not json")).toBeNull()
    expect(parseBridgeFrame("42")).toBeNull()
    expect(parseBridgeFrame(JSON.stringify({ type: "mystery", v: 1 }))).toBeNull()
    expect(parseBridgeFrame(JSON.stringify({ type: "ping" }))).toBeNull() // no v
  })

  it("keeps Agent RPC payloads opaque and newline-free", () => {
    expect(buildWorkerFrame("connection-1", '{"jsonrpc":"2.0","id":1}')).toEqual(
      fixtures.frames.workerFrame
    )
    expect(() => buildWorkerFrame("connection-1", "{}\n{}")).toThrow(/newlines/)
  })
})
