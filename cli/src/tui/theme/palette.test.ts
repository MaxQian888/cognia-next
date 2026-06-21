import { expandPalette, type BaseColors } from "./palette"

const BASE: BaseColors = {
  accent: "cyan",
  secondary: "magenta",
  info: "blue",
  success: "green",
  warning: "yellow",
  danger: "red",
  muted: "gray",
}

describe("expandPalette", () => {
  it("derives every element token from the base roles", () => {
    const p = expandPalette(BASE)
    // structure
    expect(p.border).toBe("cyan")
    expect(p.borderSubtle).toBe("gray")
    expect(p.borderWarning).toBe("yellow")
    // headings map accent / info / secondary
    expect(p.heading1).toBe("cyan")
    expect(p.heading2).toBe("blue")
    expect(p.heading3).toBe("magenta")
    // markdown inline
    expect(p.link).toBe("blue")
    expect(p.inlineCode).toBe("yellow")
    // No default inline-code background — foreground-only for a clean look.
    expect(p.inlineCodeBg).toBeUndefined()
    expect(p.blockquote).toBe("gray")
    // chat
    expect(p.userPrompt).toBe("green")
    expect(p.thinking).toBe("magenta")
    // diff
    expect(p.diffAdded).toBe("green")
    expect(p.diffRemoved).toBe("red")
    // tools
    expect(p.toolMcp).toBe("magenta")
    expect(p.toolPlugin).toBe("blue")
    // status
    expect(p.statusRunning).toBe("yellow")
    expect(p.statusDone).toBe("green")
    expect(p.statusError).toBe("red")
    // risk
    expect(p.riskLow).toBe("green")
    expect(p.riskMedium).toBe("yellow")
    expect(p.riskHigh).toBe("red")
    // mascot
    expect(p.mascotIdle).toBe("gray")
    expect(p.mascotThinking).toBe("magenta")
    expect(p.mascotWorking).toBe("yellow")
    expect(p.mascotStopping).toBe("red")
    // selection + base passthrough
    expect(p.selected).toBe("cyan")
    expect(p.accent).toBe("cyan")
    expect(p.muted).toBe("gray")
    // code-block tokens
    expect(p.codeKeyword).toBe("magenta")
    expect(p.codeString).toBe("green")
    expect(p.codeNumber).toBe("yellow")
    expect(p.codeComment).toBe("gray")
    expect(p.codeFunction).toBe("blue")
    expect(p.codeBuiltin).toBe("cyan")
  })

  it("leaves text undefined when the base omits it (terminal default fg)", () => {
    expect(expandPalette(BASE).text).toBeUndefined()
  })

  it("carries an explicit base text through", () => {
    expect(expandPalette({ ...BASE, text: "#c0caf5" }).text).toBe("#c0caf5")
  })

  it("applies per-token overrides on top of the derived defaults", () => {
    const p = expandPalette(BASE, {
      link: "#7aa2f7",
      inlineCode: "#e0af68",
      codeHighlight: "dracula",
    })
    expect(p.link).toBe("#7aa2f7")
    expect(p.inlineCode).toBe("#e0af68")
    expect(p.codeHighlight).toBe("dracula")
    // untouched tokens keep their derived value
    expect(p.heading1).toBe("cyan")
  })

  it("does not mutate the input base", () => {
    const base = { ...BASE }
    expandPalette(base, { accent: "#ff0000" })
    expect(base.accent).toBe("cyan")
  })
})
