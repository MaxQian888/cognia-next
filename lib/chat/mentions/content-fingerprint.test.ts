import { contentFingerprint } from "./content-fingerprint"
import { contentFingerprint as reexported } from "./message-reference"

describe("contentFingerprint", () => {
  it("changes when a word changes but the length does not", () => {
    expect(contentFingerprint("the cat sat")).not.toBe(contentFingerprint("the bat sat"))
  })

  it("is stable for the same text and distinguishes the empty string", () => {
    expect(contentFingerprint("same")).toBe(contentFingerprint("same"))
    expect(contentFingerprint("")).not.toBe(contentFingerprint(" "))
  })

  it("stays reachable from the reference module", () => {
    expect(reexported).toBe(contentFingerprint)
  })
})
