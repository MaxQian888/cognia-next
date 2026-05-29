import { splitPath, statusDecoration } from "./status-decoration"

describe("statusDecoration", () => {
  it("maps each status to a distinct letter", () => {
    expect(statusDecoration("modified").letter).toBe("M")
    expect(statusDecoration("added").letter).toBe("A")
    expect(statusDecoration("deleted").letter).toBe("D")
    expect(statusDecoration("renamed").letter).toBe("R")
    expect(statusDecoration("untracked").letter).toBe("U")
    expect(statusDecoration("conflicted").letter).toBe("C")
    expect(statusDecoration("typeChanged").letter).toBe("T")
  })

  it("provides a color class and label key", () => {
    const d = statusDecoration("modified")
    expect(d.colorClass).toContain("text-")
    expect(d.labelKey).toBe("modified")
  })
})

describe("splitPath", () => {
  it("splits dir and name", () => {
    expect(splitPath("src/lib/a.ts")).toEqual({ dir: "src/lib", name: "a.ts" })
  })
  it("handles root-level files", () => {
    expect(splitPath("README.md")).toEqual({ dir: "", name: "README.md" })
  })
})
