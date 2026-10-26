import { sha256Hex } from "./hash"

describe("sha256Hex", () => {
  it("matches the known empty-string vector", async () => {
    expect(await sha256Hex("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    )
  })

  it("produces 64 lowercase hex chars and is case-sensitive", async () => {
    expect(await sha256Hex("anything")).toMatch(/^[0-9a-f]{64}$/)
    expect(await sha256Hex("payload")).not.toBe(await sha256Hex("PAYLOAD"))
  })
})
