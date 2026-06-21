import { osc8Link, supportsHyperlinks } from "./hyperlink"

const ESC = ""
const BEL = ""

describe("osc8Link", () => {
  it("wraps the label in an OSC-8 sequence pointing at the url", () => {
    expect(osc8Link("https://a.test/x", "docs")).toBe(
      `${ESC}]8;;https://a.test/x${BEL}docs${ESC}]8;;${BEL}`
    )
  })

  it("keeps the visible label intact (escapes are zero-width)", () => {
    const out = osc8Link("https://a.test", "click here")
    expect(out).toContain("click here")
    expect(out.startsWith(`${ESC}]8;;`)).toBe(true)
  })
})

describe("supportsHyperlinks", () => {
  it("honours FORCE_HYPERLINK over everything else", () => {
    expect(supportsHyperlinks({ FORCE_HYPERLINK: "1", CI: "1" })).toBe(true)
    expect(supportsHyperlinks({ FORCE_HYPERLINK: "0", TERM_PROGRAM: "iTerm.app" })).toBe(false)
    expect(supportsHyperlinks({ FORCE_HYPERLINK: "false", WT_SESSION: "x" })).toBe(false)
  })

  it("stays off in CI", () => {
    expect(supportsHyperlinks({ CI: "true" })).toBe(false)
  })

  it("detects Windows Terminal, kitty, ghostty", () => {
    expect(supportsHyperlinks({ WT_SESSION: "abc" })).toBe(true)
    expect(supportsHyperlinks({ KITTY_WINDOW_ID: "1" })).toBe(true)
    expect(supportsHyperlinks({ TERM: "xterm-kitty" })).toBe(true)
    expect(supportsHyperlinks({ TERM_PROGRAM: "ghostty" })).toBe(true)
  })

  it("detects known TERM_PROGRAM terminals", () => {
    for (const p of ["iTerm.app", "WezTerm", "vscode", "Hyper"]) {
      expect(supportsHyperlinks({ TERM_PROGRAM: p })).toBe(true)
    }
  })

  it("detects VTE >= 5000 but not older", () => {
    expect(supportsHyperlinks({ VTE_VERSION: "5202" })).toBe(true)
    expect(supportsHyperlinks({ VTE_VERSION: "4900" })).toBe(false)
    expect(supportsHyperlinks({ VTE_VERSION: "not-a-number" })).toBe(false)
  })

  it("returns false for an unknown terminal", () => {
    expect(supportsHyperlinks({ TERM: "xterm-256color" })).toBe(false)
    expect(supportsHyperlinks({})).toBe(false)
  })
})
