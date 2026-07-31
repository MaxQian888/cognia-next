import { createPiiRedactionGate } from "./pii-gate"

describe("createPiiRedactionGate", () => {
  it("rewrites a string arg containing an email into a placeholder", async () => {
    const gate = createPiiRedactionGate()
    const result = await gate("web_fetch", { url: "mail to alice@example.com now" }, {})
    expect(result.behavior).toBe("allow")
    if (result.behavior !== "allow") throw new Error("expected allow")
    expect(result.updatedInput?.url).not.toContain("alice@example.com")
    expect(String(result.updatedInput?.url)).toMatch(/<EMAIL_\d+>/)
  })

  it("redacts nested object and array string leaves", async () => {
    const gate = createPiiRedactionGate()
    const result = await gate(
      "x",
      {
        meta: { contact: "call +14155552671" },
        items: ["token sk-abc1234567890abcdef1234567890abcdef", "plain"],
      },
      {}
    )
    if (result.behavior !== "allow") throw new Error("expected allow")
    const meta = result.updatedInput?.meta as { contact: string }
    const items = result.updatedInput?.items as string[]
    expect(meta.contact).not.toContain("4155552671")
    expect(items[0]).not.toContain("sk-abc1234567890abcdef1234567890abcdef")
    expect(items[1]).toBe("plain")
  })

  it("allows unchanged (no updatedInput) when there is no PII", async () => {
    const gate = createPiiRedactionGate()
    const result = await gate("x", { q: "hello world", n: 42 }, {})
    expect(result).toEqual({ behavior: "allow" })
  })

  it("fires onRedact with the placeholder count when something is rewritten", async () => {
    const onRedact = jest.fn()
    const gate = createPiiRedactionGate({ onRedact })
    await gate("tool", { a: "alice@example.com", b: "bob@example.com" }, {})
    expect(onRedact).toHaveBeenCalledWith("tool", 2)
  })

  it("redacts seeded name hints", async () => {
    const gate = createPiiRedactionGate({ nameHints: ["Zaphod Beeblebrox"] })
    const result = await gate("x", { note: "ping Zaphod Beeblebrox" }, {})
    if (result.behavior !== "allow") throw new Error("expected allow")
    expect(String(result.updatedInput?.note)).not.toContain("Zaphod Beeblebrox")
  })

  it("leaves non-string leaves untouched", async () => {
    const gate = createPiiRedactionGate()
    const result = await gate("x", { n: 1, b: true, nil: null }, {})
    expect(result).toEqual({ behavior: "allow" })
  })
})
