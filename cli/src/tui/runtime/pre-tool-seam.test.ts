import { createPreToolSeam, MUTATING_TOOLS } from "./pre-tool-seam"

describe("pre-tool seam", () => {
  it("classifies mutating tools", () => {
    const seam = createPreToolSeam()
    expect(seam.isMutating("Edit")).toBe(true)
    expect(seam.isMutating("Write")).toBe(true)
    expect(seam.isMutating("Grep")).toBe(false)
  })
  it("runs observers in order and aggregates deny", async () => {
    const seam = createPreToolSeam()
    const calls: string[] = []
    seam.subscribe(async (ev) => {
      calls.push("a:" + ev.toolName)
      return undefined
    })
    seam.subscribe(async () => ({ deny: true, reason: "blocked" }))
    const res = await seam.dispatch({ toolName: "Edit", args: { file_path: "/x" } })
    expect(calls).toEqual(["a:Edit"])
    expect(res).toEqual({ deny: true, reason: "blocked" })
  })
  it("returns undefined when no observer denies", async () => {
    const seam = createPreToolSeam()
    seam.subscribe(async () => undefined)
    expect(await seam.dispatch({ toolName: "Write", args: {} })).toBeUndefined()
  })
  it("unsubscribe removes an observer", async () => {
    const seam = createPreToolSeam()
    const calls: string[] = []
    const off = seam.subscribe(() => {
      calls.push("denied")
      return { deny: true }
    })
    off()
    // Unsubscribing twice is a no-op and must not throw.
    off()
    const res = await seam.dispatch({ toolName: "Edit", args: {} })
    expect(calls).toEqual([])
    expect(res).toBeUndefined()
  })
  it("honors a custom mutating set and enriches isMutating", async () => {
    const seam = createPreToolSeam(new Set(["Custom"]))
    expect(seam.isMutating("Custom")).toBe(true)
    expect(seam.isMutating("Edit")).toBe(false)
    expect(MUTATING_TOOLS.has("Edit")).toBe(true)
    let seen: boolean | undefined
    seam.subscribe((ev) => {
      seen = ev.isMutating
    })
    await seam.dispatch({ toolName: "Custom", args: {} })
    expect(seen).toBe(true)
  })
})
