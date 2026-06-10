/**
 * @jest-environment node
 */
import { formatArgHint } from "./arg-hint"
import type { CommandDescriptor } from "./types"

const base: CommandDescriptor = {
  name: "x",
  description: "x",
  category: "system",
  handler: () => ({ kind: "none" }),
}

describe("formatArgHint", () => {
  it("prefers an explicit argumentHint", () => {
    expect(formatArgHint({ ...base, argumentHint: "<objective>" })).toBe("<objective>")
  })

  it("synthesises a verb list from subcommands", () => {
    expect(
      formatArgHint({
        ...base,
        subcommands: [
          { name: "status", description: "", handler: () => ({ kind: "none" }) },
          { name: "pause", description: "", handler: () => ({ kind: "none" }) },
        ],
      })
    ).toBe("<status | pause>")
  })

  it("synthesises required positional and optional flag args", () => {
    expect(
      formatArgHint({
        ...base,
        args: [
          { name: "id", label: "Id", type: "string", required: true, style: "positional" },
          { name: "force", label: "Force", type: "boolean" },
        ],
      })
    ).toBe("<id> [--force]")
  })

  it("returns an empty string when there is nothing to hint", () => {
    expect(formatArgHint(base)).toBe("")
  })
})
