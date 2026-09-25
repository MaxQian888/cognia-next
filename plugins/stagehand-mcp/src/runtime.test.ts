import { getSetupModalHost, setSetupModalHost } from "./runtime"

describe("setup modal host slot", () => {
  afterEach(() => setSetupModalHost(undefined))

  it("round-trips the published host handles and clears back to undefined", () => {
    expect(getSetupModalHost()).toBeUndefined()
    const host = { shell: { execute: jest.fn() }, navigate: jest.fn(() => true) }
    setSetupModalHost(host)
    expect(getSetupModalHost()).toBe(host)
    setSetupModalHost(undefined)
    expect(getSetupModalHost()).toBeUndefined()
  })
})
