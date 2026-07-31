/**
 * @jest-environment node
 */
import { displaySkillName, formatActiveSkillsNotice } from "./active-skills"

describe("displaySkillName", () => {
  it("shows the last colon-segment of a canonical id", () => {
    expect(displaySkillName("cli-disk:project:my-skill")).toBe("my-skill")
    expect(displaySkillName("builtin:web-search")).toBe("web-search")
  })

  it("shows a colon-less id verbatim", () => {
    expect(displaySkillName("standalone")).toBe("standalone")
  })

  it("trims surrounding whitespace and falls back to the trimmed id for a trailing colon", () => {
    expect(displaySkillName("  spaced  ")).toBe("spaced")
    expect(displaySkillName("group:")).toBe("group:")
  })
})

describe("formatActiveSkillsNotice", () => {
  it("lists the active skills with a count", () => {
    expect(formatActiveSkillsNotice(["builtin:web-search", "cli-disk:p:my-skill"])).toBe(
      "Active skills (2): web-search, my-skill"
    )
  })

  it("returns null when there are no skills (caller skips the notice)", () => {
    expect(formatActiveSkillsNotice([])).toBeNull()
  })

  it("ignores ids that collapse to an empty name", () => {
    expect(formatActiveSkillsNotice(["", "  "])).toBeNull()
    expect(formatActiveSkillsNotice(["builtin:real", ""])).toBe("Active skills (1): real")
  })
})
