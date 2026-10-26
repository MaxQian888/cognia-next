import { compositeEditRoute, conversationBoundRoute } from "./message-route"

describe("conversationBoundRoute (ADR-0239)", () => {
  it("keeps every reply and edit in the reference's chat", async () => {
    await expect(conversationBoundRoute()).resolves.toBe("within")
  })
})

describe("compositeEditRoute (ADR-0239)", () => {
  it("keeps a reply in the reference's chat, whatever the id names", () => {
    expect(compositeEditRoute("reply", "other", "c1")).toBe("within")
    expect(compositeEditRoute("reply", undefined, "")).toBe("within")
  })

  it("places an edit by the chat its composite id names", () => {
    expect(compositeEditRoute("edit", "c1", "c1")).toBe("within")
    expect(compositeEditRoute("edit", "c2", "c1")).toBe("elsewhere")
  })

  it("edits a bare id in the reference's chat, when it names one", () => {
    expect(compositeEditRoute("edit", undefined, "c1")).toBe("within")
    expect(compositeEditRoute("edit", undefined, "")).toBe("unknown")
    expect(compositeEditRoute("edit", "c1", "")).toBe("unknown")
  })
})
