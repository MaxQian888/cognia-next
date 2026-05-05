import { ALL_CAPABILITIES, defaultDegradeChain, hasCapability, type Capability } from "./capability"

describe("capability flags", () => {
  it("ALL_CAPABILITIES includes the core text/markdown/file family", () => {
    for (const c of [
      "send.text",
      "send.markdown",
      "send.image",
      "send.file",
      "send.reply",
      "send.mention",
      "send.thread",
      "edit",
      "delete",
      "typing",
      "history.fetch",
    ] as Capability[]) {
      expect(ALL_CAPABILITIES).toContain(c)
    }
  })

  it("hasCapability matches case-sensitively", () => {
    const adapter = ["send.text", "send.markdown"] as Capability[]
    expect(hasCapability(adapter, "send.text")).toBe(true)
    expect(hasCapability(adapter, "send.image")).toBe(false)
  })

  it("defaultDegradeChain falls card → markdown → text", () => {
    expect(defaultDegradeChain("card")).toEqual(["card", "markdown", "text"])
    expect(defaultDegradeChain("markdown")).toEqual(["markdown", "text"])
    expect(defaultDegradeChain("text")).toEqual(["text"])
  })
})
