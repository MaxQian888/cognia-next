import { UNTRUSTED_CONTENT_NOTICE, wrapUntrustedContent } from "./untrusted-content"
import {
  UNTRUSTED_CONTENT_NOTICE as reexportedNotice,
  wrapUntrustedContent as reexportedWrap,
} from "./web-tools-core"

describe("wrapUntrustedContent", () => {
  it("puts the notice above the text, separated by a blank line", () => {
    expect(wrapUntrustedContent("body")).toBe(`${UNTRUSTED_CONTENT_NOTICE}\n\nbody`)
  })

  it("tells the model the content is data, not instructions", () => {
    // The whole point of the banner — a third party's text must not be able to
    // issue commands by being quoted into a prompt.
    expect(UNTRUSTED_CONTENT_NOTICE).toMatch(/not instructions/i)
    expect(UNTRUSTED_CONTENT_NOTICE).toMatch(/do not follow/i)
  })

  it("wraps empty text rather than returning nothing", () => {
    expect(wrapUntrustedContent("")).toBe(`${UNTRUSTED_CONTENT_NOTICE}\n\n`)
  })

  it("does not nest a second notice — wrapping is the caller's decision", () => {
    const once = wrapUntrustedContent("body")
    expect(wrapUntrustedContent(once).indexOf(UNTRUSTED_CONTENT_NOTICE)).toBe(0)
  })

  it("stays reachable under its historical name in web-tools-core", () => {
    // Existing importers were left untouched by the extraction.
    expect(reexportedWrap).toBe(wrapUntrustedContent)
    expect(reexportedNotice).toBe(UNTRUSTED_CONTENT_NOTICE)
  })
})
