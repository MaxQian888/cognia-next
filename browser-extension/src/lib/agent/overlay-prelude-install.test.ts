/** @jest-environment jsdom */

describe("overlay-prelude-install", () => {
  afterEach(() => {
    for (const key of ["__cogniaPreludeInstalled", "__cogniaNavTo", "__cogniaSignal"]) {
      delete (window as unknown as Record<string, unknown>)[key]
    }
    delete (globalThis as { chrome?: unknown }).chrome
    jest.resetModules()
  })

  it("installs the prelude on import, forwarding new-tab opens to the worker", async () => {
    const sendMessage = jest.fn(async () => undefined)
    ;(globalThis as { chrome?: unknown }).chrome = { runtime: { sendMessage } }
    await import("./overlay-prelude-install")
    const win = window as unknown as Record<string, unknown>
    expect(win.__cogniaPreludeInstalled).toBe(true)
    expect(typeof win.__cogniaSignal).toBe("function")
    ;(win.__cogniaNavTo as (url: string) => void)("https://example.com/next")
    expect(sendMessage).toHaveBeenCalledWith({
      kind: "cognia-agent-open-tab",
      url: "https://example.com/next",
    })
  })
})
