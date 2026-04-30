import { LucideIcons } from "./resolve-icon"
import { Bot, Code2 } from "lucide-react"

describe("LucideIcons", () => {
  it("resolves a known icon by name to the same component lucide-react exports", () => {
    expect(LucideIcons.Bot).toBe(Bot)
    expect(LucideIcons.Code2).toBe(Code2)
  })

  it("returns undefined for an unknown icon name", () => {
    expect(LucideIcons["DefinitelyNotARealIcon"]).toBeUndefined()
  })
})
