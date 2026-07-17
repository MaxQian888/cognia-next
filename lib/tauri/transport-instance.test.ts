/**
 * Pins the desktop transport selection: on Tauri the process transport is a
 * `RoutingTransport` (ADR-0082) so a remote host can be driven, and it routes
 * to local until a remote is installed. `setTransport` still fully swaps the
 * binding (the CLI escape hatch).
 */

// TDZ-safe: define the jest.fn()s inside the factory, then re-import handles.
jest.mock("@/lib/platform/detect", () => ({
  isTauri: jest.fn(() => false),
  isCapacitor: jest.fn(() => false),
}))
jest.mock("@/lib/platform/web-companion", () => ({
  hasWebCompanionTarget: jest.fn(() => false),
}))

import { isCapacitor, isTauri } from "@/lib/platform/detect"
import type { Transport } from "./transport-types"

const isTauriMock = isTauri as jest.Mock
const isCapacitorMock = isCapacitor as jest.Mock

// `jest.isolateModules` re-evaluates the module (so `pickTransport` re-runs with
// the current platform mock). It also loads a *fresh* copy of the dependency
// graph, so `RoutingTransport` must be required from the SAME isolated registry
// — the top-level class object would be a different identity and `instanceof`
// would fail even for a genuine RoutingTransport.
function loadInstance(): {
  mod: typeof import("./transport-instance")
  Routing: typeof import("./transport-routing").RoutingTransport
} {
  let mod!: typeof import("./transport-instance")
  let Routing!: typeof import("./transport-routing").RoutingTransport
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    mod = require("./transport-instance") as typeof import("./transport-instance")
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    Routing = (require("./transport-routing") as typeof import("./transport-routing"))
      .RoutingTransport
  })
  return { mod, Routing }
}

describe("transport-instance selection", () => {
  beforeEach(() => {
    isTauriMock.mockReset().mockReturnValue(false)
    isCapacitorMock.mockReset().mockReturnValue(false)
  })

  it("wraps the local transport in a RoutingTransport on desktop", () => {
    isTauriMock.mockReturnValue(true)
    const { mod, Routing } = loadInstance()
    expect(mod.transport).toBeInstanceOf(Routing)
  })

  it("does not use RoutingTransport off desktop", () => {
    // Plain web (no Tauri, no Capacitor, no web-companion) → WebStubTransport.
    const { mod, Routing } = loadInstance()
    expect(mod.transport).not.toBeInstanceOf(Routing)
  })

  it("setTransport fully replaces the binding", () => {
    isTauriMock.mockReturnValue(true)
    const { mod, Routing } = loadInstance()
    expect(mod.transport).toBeInstanceOf(Routing)

    const fake: Transport = { call: jest.fn(), subscribe: jest.fn(() => () => {}) }
    mod.setTransport(fake)
    expect(mod.transport).toBe(fake)
  })
})
