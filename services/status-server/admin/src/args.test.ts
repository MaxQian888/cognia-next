import { describe, expect, it } from "vitest"

import {
  UsageError,
  integerValue,
  listValue,
  optionalValue,
  parseArgs,
  requiredValue,
} from "./args"

const known = {
  values: ["title-en", "revision", "components", "profile"],
  switches: ["yes", "pin"],
}

describe("parseArgs", () => {
  it("parses values, switches, = forms, repeats and positionals", () => {
    const args = parseArgs(
      ["inc_1", "--title-en", "Down", "--revision=3", "--yes", "--profile", "a", "--profile=b"],
      known
    )
    expect(args.positionals).toEqual(["inc_1"])
    expect(optionalValue(args, "title-en")).toBe("Down")
    expect(integerValue(args, "revision", true)).toBe(3)
    expect(args.switches.has("yes")).toBe(true)
    expect(args.values.get("profile")).toEqual(["a", "b"])
  })

  it("rejects unknown options, missing values and values on switches", () => {
    expect(() => parseArgs(["--titel-en", "x"], known)).toThrow(UsageError)
    expect(() => parseArgs(["--title-en"], known)).toThrow("needs a value")
    expect(() => parseArgs(["--title-en", "--yes"], known)).toThrow("needs a value")
    expect(() => parseArgs(["--yes=1"], known)).toThrow("takes no value")
  })

  it("validates required, integer and list values", () => {
    const args = parseArgs(
      ["--revision", "x", "--components", "a, b,,c", "--title-en", "a", "--title-en", "b"],
      known
    )
    expect(() => integerValue(args, "revision", true)).toThrow("non-negative integer")
    expect(listValue(args, "components")).toEqual(["a", "b", "c"])
    expect(() => requiredValue(args, "title-en")).toThrow("more than once")
    expect(() => requiredValue(parseArgs([], known), "title-en")).toThrow("is required")
  })
})
