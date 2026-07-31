import { __resetHeadlessRuntimesForTesting, listHeadlessRuntimes } from "../registry"

describe("headless runtime roster", () => {
  it("importing the anchor registers the extracted runtimes without error", async () => {
    __resetHeadlessRuntimesForTesting()
    await import("./index")
    // T-A2..A9 extraction slices grow this list; the anchor itself must
    // always be importable in Node (the brain imports it once at boot).
    const names = listHeadlessRuntimes().map((r) => r.name)
    expect(Array.isArray(names)).toBe(true)
  })
})
