import * as runtimeTypes from "./types"
import type { ErrorParser, ErrorPreset, ParsedError } from "./types"

describe("error parser type contracts", () => {
  it("keeps the runtime module empty while preserving compile-time contracts", () => {
    expect(runtimeTypes).toEqual({})

    const parsed: ParsedError = {
      parsed: true,
      nodes: [
        {
          kind: "statusCode",
          content: "HTTP 429",
          status: 429,
          category: "rateLimited",
        },
      ],
    }

    const parser: ErrorParser = {
      name: "status",
      parse: (text) => (text.includes("429") ? parsed : null),
    }

    const preset: ErrorPreset = {
      name: "default",
      parsers: [parser],
      parse: (text) =>
        parser.parse(text) ?? { parsed: false, nodes: [{ kind: "text", content: text }] },
    }

    expect(preset.parse("HTTP 429")).toBe(parsed)
    expect(preset.parse("plain").parsed).toBe(false)
  })
})
