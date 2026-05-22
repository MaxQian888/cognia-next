/**
 * @jest-environment jsdom
 */

let mockIsTauri = false
let mockIsCapacitor = false

jest.mock("@/lib/tauri", () => ({
  isTauri: () => mockIsTauri,
  isCapacitor: () => mockIsCapacitor,
}))

import { selectTerminalTransport, terminalAvailable } from "./pick-transport"

beforeEach(() => {
  mockIsTauri = false
  mockIsCapacitor = false
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
