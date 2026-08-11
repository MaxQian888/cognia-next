import { z } from "zod"

import {
  MAX_STRUCTURED_CONFIG_BYTES,
  parseStructuredConfig,
  serializeStructuredConfig,
} from "./structured-config"

const schema = z
  .object({
    name: z.string().min(1),
    enabled: z.boolean(),
    retries: z.number().int().min(0),
  })
  .strict()

describe("structured config codec", () => {
  it.each([
    ["json" as const, '{"name":"edge","enabled":true,"retries":2}'],
    ["yaml" as const, "name: edge\nenabled: true\nretries: 2\n"],
  ])("parses and validates %s", (format, input) => {
    expect(parseStructuredConfig(input, format, (value) => schema.parse(value))).toEqual({
      name: "edge",
      enabled: true,
      retries: 2,
    })
  })

  it("serializes stable JSON and YAML that round-trip through the validator", () => {
    const value = { name: "edge", enabled: false, retries: 0 }

    for (const format of ["json", "yaml"] as const) {
      const serialized = serializeStructuredConfig(value, format)
      expect(parseStructuredConfig(serialized, format, (input) => schema.parse(input))).toEqual(
        value
      )
    }
  })

  it("rejects malformed input, unknown fields, aliases, and oversized files", () => {
    expect(() => parseStructuredConfig("{", "json", (value) => schema.parse(value))).toThrow()
    expect(() =>
      parseStructuredConfig("name: edge\nname: duplicate\n", "yaml", (value) => value)
    ).toThrow(/Map keys must be unique/i)
    expect(() =>
      parseStructuredConfig(
        '{"name":"edge","enabled":true,"retries":2,"secret":"no"}',
        "json",
        (value) => schema.parse(value)
      )
    ).toThrow(/secret/)
    expect(() =>
      parseStructuredConfig(
        "base: &base {name: edge, enabled: true, retries: 2}\ncopy: *base\n",
        "yaml",
        (value) => value
      )
    ).toThrow(/alias/i)
    expect(() =>
      parseStructuredConfig("x".repeat(MAX_STRUCTURED_CONFIG_BYTES + 1), "yaml", (value) => value)
    ).toThrow(/too large/i)
  })
})
