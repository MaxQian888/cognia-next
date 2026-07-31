/**
 * @jest-environment jsdom
 */

let mockIsTauri = false
let mockIsCapacitor = false

jest.mock("@/lib/tauri", () => ({
  isTauri: () => mockIsTauri,
  isCapacitor: () => mockIsCapacitor,
}))

import { __resetRoutingForTests, setActiveRemoteTransport } from "@/lib/tauri/transport-routing"
import type { Transport } from "@/lib/tauri/transport-types"
import {
  selectTerminalTransport,
  selectTerminalTransportChain,
  terminalAvailable,
} from "./pick-transport"

const activeRemoteFake: Transport = {
  call: (async () => undefined) as Transport["call"],
  subscribe: () => () => {},
}

beforeEach(() => {
  mockIsTauri = false
  mockIsCapacitor = false
  __resetRoutingForTests()
})
afterEach(() => {
  __resetRoutingForTests()
})

describe("selectTerminalTransport", () => {
  it("returns tauri-channel inside Tauri", () => {
    mockIsTauri = true
    expect(selectTerminalTransport()).toBe("tauri-channel")
  })

  it("returns ws inside Capacitor", () => {
    mockIsCapacitor = true
    expect(selectTerminalTransport()).toBe("ws")
  })

  it("returns unsupported in plain browser", () => {
    expect(selectTerminalTransport()).toBe("unsupported")
  })

  it("prefers tauri-channel over ws when both flags are set (defensive)", () => {
    mockIsTauri = true
    mockIsCapacitor = true
    expect(selectTerminalTransport()).toBe("tauri-channel")
  })
})

describe("terminalAvailable", () => {
  it("returns true on Tauri", () => {
    mockIsTauri = true
    expect(terminalAvailable()).toBe(true)
  })

  it("returns true on Capacitor", () => {
    mockIsCapacitor = true
    expect(terminalAvailable()).toBe(true)
  })

  it("returns false in plain browser", () => {
    expect(terminalAvailable()).toBe(false)
  })
})

describe("selectTerminalTransportChain", () => {
  it("returns only tauri-channel on Tauri (no remote ambiguity)", () => {
    mockIsTauri = true
    expect(selectTerminalTransportChain()).toEqual(["tauri-channel"])
  })

  it("tries LAN first and WebRTC second on Capacitor", () => {
    mockIsCapacitor = true
    expect(selectTerminalTransportChain()).toEqual(["ws", "webrtc"])
  })

  it("returns an empty chain in plain browser", () => {
    expect(selectTerminalTransportChain()).toEqual([])
  })
})

describe("remote host active (ADR-0082)", () => {
  it("selectTerminalTransport returns ws on desktop when a remote host is active", () => {
    mockIsTauri = true
    setActiveRemoteTransport(activeRemoteFake)
    expect(selectTerminalTransport()).toBe("ws")
  })

  it("tries the active remote host over LAN then WebRTC", () => {
    mockIsTauri = true
    setActiveRemoteTransport(activeRemoteFake)
    expect(selectTerminalTransportChain()).toEqual(["ws", "webrtc"])
  })

  it("reverts to tauri-channel once the remote host is cleared", () => {
    mockIsTauri = true
    setActiveRemoteTransport(activeRemoteFake)
    setActiveRemoteTransport(null)
    expect(selectTerminalTransport()).toBe("tauri-channel")
  })
})
