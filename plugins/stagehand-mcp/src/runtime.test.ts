import { getPluginShell, setPluginShell } from "./runtime"

describe("plugin shell slot", () => {
  afterEach(() => setPluginShell(undefined))

  it("round-trips the published shell API and clears back to undefined", () => {
    expect(getPluginShell()).toBeUndefined()
    const shell = { execute: jest.fn() }
    setPluginShell(shell as never)
    expect(getPluginShell()).toBe(shell)
    setPluginShell(undefined)
    expect(getPluginShell()).toBeUndefined()
  })
})
