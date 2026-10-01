let capacitor = false
let webCompanion = false
jest.mock("@/lib/platform/detect", () => ({ isCapacitor: () => capacitor }))
jest.mock("@/lib/platform/web-companion", () => ({ hasWebCompanionTarget: () => webCompanion }))

import { isMirroredPluginClient } from "./mirrored-client"

describe("isMirroredPluginClient", () => {
  beforeEach(() => {
    capacitor = false
    webCompanion = false
  })

  it("is the authority on a host", () => {
    expect(isMirroredPluginClient()).toBe(false)
  })

  it("mirrors on the Capacitor shell and on a browser driving a host", () => {
    capacitor = true
    expect(isMirroredPluginClient()).toBe(true)
    capacitor = false
    webCompanion = true
    expect(isMirroredPluginClient()).toBe(true)
  })
})
