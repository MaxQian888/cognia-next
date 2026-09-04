/** @jest-environment jsdom */
import { onPetConsoleRequest, requestPetConsole } from "./console-request"

describe("pet console request", () => {
  it("delivers the requested tab to a subscriber", () => {
    const seen: unknown[] = []
    const off = onPetConsoleRequest((d) => seen.push(d))
    expect(requestPetConsole({ tab: "shop" })).toBe(true)
    expect(seen).toEqual([{ tab: "shop" }])
    off()
  })

  it("delivers an empty detail when no tab is named", () => {
    const seen: unknown[] = []
    const off = onPetConsoleRequest((d) => seen.push(d))
    requestPetConsole()
    expect(seen).toEqual([{}])
    off()
  })

  it("stops delivering after unsubscribe", () => {
    const seen: unknown[] = []
    const off = onPetConsoleRequest((d) => seen.push(d))
    off()
    requestPetConsole({ tab: "journal" })
    expect(seen).toEqual([])
  })
})
