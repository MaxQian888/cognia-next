/**
 * @jest-environment jsdom
 */

let mockIsTauri = false
let mockIsCapacitor = false
let mockHasWebCompanionTarget = false

jest.mock("@/lib/tauri", () => ({
  isTauri: () => mockIsTauri,
  isCapacitor: () => mockIsCapacitor,
}))

jest.mock("@/lib/platform/web-companion", () => ({
  hasWebCompanionTarget: () => mockHasWebCompanionTarget,
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
  mockHasWebCompanionTarget = false
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

describe("cloud companion (ADR-0059 C1)", () => {
  it("returns ws in a browser paired to a cognia-server", () => {
    mockHasWebCompanionTarget = true
    expect(selectTerminalTransport()).toBe("ws")
  })

  it("reports the terminal as available", () => {
    mockHasWebCompanionTarget = true
    expect(terminalAvailable()).toBe(true)
  })

  it("tries the server over ws then WebRTC", () => {
    mockHasWebCompanionTarget = true
    expect(selectTerminalTransportChain()).toEqual(["ws", "webrtc"])
  })

  it("stays unsupported for a web standalone build with no server", () => {
    expect(selectTerminalTransport()).toBe("unsupported")
    expect(selectTerminalTransportChain()).toEqual([])
    expect(terminalAvailable()).toBe(false)
  })

  it("keeps the in-process PTY on Tauri even with a build-time server URL", () => {
    // The same bundle feeds the browser and the desktop shell, so a baked-in
    // NEXT_PUBLIC_COGNIA_SERVER_URL must not divert the desktop off its local
    // PTY — the web-companion branch is checked last for exactly this reason.
    mockIsTauri = true
    mockHasWebCompanionTarget = true
    expect(selectTerminalTransport()).toBe("tauri-channel")
    expect(selectTerminalTransportChain()).toEqual(["tauri-channel"])
  })

  it("keeps the Capacitor chain when a build-time server URL is also present", () => {
    mockIsCapacitor = true
    mockHasWebCompanionTarget = true
    expect(selectTerminalTransport()).toBe("ws")
    expect(selectTerminalTransportChain()).toEqual(["ws", "webrtc"])
  })
})
