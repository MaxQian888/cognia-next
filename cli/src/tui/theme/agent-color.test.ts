import { agentInkColor } from "./agent-color"

describe("agentInkColor", () => {
  it("maps ANSI-native palette names onto Ink keywords", () => {
    expect(agentInkColor("cyan", "#accent")).toBe("cyan")
    expect(agentInkColor("Purple", "#accent")).toBe("magenta")
    expect(agentInkColor("grey", "#accent")).toBe("gray")
  })

  it("gives the names the 16-colour set lacks a fixed hex", () => {
    expect(agentInkColor("orange", "#accent")).toMatch(/^#[0-9a-f]{6}$/)
    expect(agentInkColor("pink", "#accent")).toMatch(/^#[0-9a-f]{6}$/)
  })

  it("passes hex through and falls back for anything undeclared", () => {
    expect(agentInkColor("#ABCDEF", "#accent")).toBe("#abcdef")
    expect(agentInkColor(undefined, "#accent")).toBe("#accent")
    expect(agentInkColor("", "#accent")).toBe("#accent")
    expect(agentInkColor("chartreuse", "#accent")).toBe("#accent")
  })
})
