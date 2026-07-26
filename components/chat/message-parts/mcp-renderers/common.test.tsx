import { render, screen } from "@testing-library/react"
import {
  blockMediaSrc,
  parseOutputJson,
  hostOf,
  languageFromPath,
  McpCardShell,
  useParsedOutput,
} from "./common"
import { renderHook } from "@testing-library/react"

describe("parseOutputJson", () => {
  it("returns null for null / undefined", () => {
    expect(parseOutputJson(null)).toBeNull()
    expect(parseOutputJson(undefined)).toBeNull()
  })

  it("returns null for an empty / whitespace string", () => {
    expect(parseOutputJson("")).toBeNull()
    expect(parseOutputJson("   ")).toBeNull()
  })

  it("returns null when a string is not valid JSON", () => {
    expect(parseOutputJson("not json")).toBeNull()
  })

  it("parses a valid JSON string", () => {
    expect(parseOutputJson('{"a":1}')).toEqual({ a: 1 })
  })

  it("passes an object payload through unchanged", () => {
    const obj = { already: "parsed" }
    expect(parseOutputJson(obj)).toBe(obj)
  })

  it("returns null for non-string, non-object scalars", () => {
    expect(parseOutputJson(42)).toBeNull()
    expect(parseOutputJson(true)).toBeNull()
  })
})

describe("useParsedOutput", () => {
  it("memoizes the parse result across re-renders with a stable input", () => {
    const { result, rerender } = renderHook(({ out }) => useParsedOutput<{ a: number }>(out), {
      initialProps: { out: '{"a":1}' },
    })
    const first = result.current
    rerender({ out: '{"a":1}' })
    // Same string content but the same reference → memo keeps the same object.
    expect(result.current).toBe(first)
    expect(first).toEqual({ a: 1 })
  })
})

describe("hostOf", () => {
  it("extracts the hostname from a valid URL", () => {
    expect(hostOf("https://example.com/path?q=1")).toBe("example.com")
  })

  it("falls back to the raw string when the value is not a URL", () => {
    expect(hostOf("not a url")).toBe("not a url")
  })
})

describe("languageFromPath", () => {
  it("returns 'text' when the path is undefined", () => {
    expect(languageFromPath(undefined)).toBe("text")
  })

  it("maps a known extension (case-insensitive) to its language", () => {
    expect(languageFromPath("src/index.TS")).toBe("typescript")
    expect(languageFromPath("a.mjs")).toBe("javascript")
    expect(languageFromPath("main.c")).toBe("c")
  })

  it("returns 'text' for an unknown extension", () => {
    expect(languageFromPath("notes.xyz")).toBe("text")
  })

  it("returns 'text' for a path with no extension", () => {
    expect(languageFromPath("Makefile")).toBe("text")
  })
})

describe("blockMediaSrc", () => {
  it("builds a data URL from the MCP wire shape", () => {
    expect(blockMediaSrc({ type: "image", data: "AAAA", mimeType: "image/png" }, "image/png")).toBe(
      "data:image/png;base64,AAAA"
    )
  })

  it("builds a data URL from the Anthropic source shape", () => {
    expect(
      blockMediaSrc(
        { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "BBBB" } },
        "image/png"
      )
    ).toBe("data:image/jpeg;base64,BBBB")
  })

  it("falls back to the caller's mime when the block declares none", () => {
    expect(blockMediaSrc({ type: "audio", data: "CCCC" }, "audio/mpeg")).toBe(
      "data:audio/mpeg;base64,CCCC"
    )
    expect(
      blockMediaSrc({ type: "image", source: { type: "base64", data: "DDDD" } }, "image/png")
    ).toBe("data:image/png;base64,DDDD")
  })

  it("passes an already-encoded data URL through untouched", () => {
    expect(blockMediaSrc({ type: "image", data: "data:image/gif;base64,EEEE" }, "image/png")).toBe(
      "data:image/gif;base64,EEEE"
    )
    expect(
      blockMediaSrc(
        { type: "image", source: { type: "base64", data: "data:image/gif;base64,FFFF" } },
        "image/png"
      )
    ).toBe("data:image/gif;base64,FFFF")
  })

  it("returns null when the block carries no payload", () => {
    expect(blockMediaSrc({ type: "image" }, "image/png")).toBeNull()
    expect(blockMediaSrc({ type: "image", data: "" }, "image/png")).toBeNull()
    expect(blockMediaSrc({ type: "text", text: "hi" }, "image/png")).toBeNull()
    expect(
      blockMediaSrc({ type: "image", source: { type: "base64", data: "" } }, "image/png")
    ).toBeNull()
  })
})

describe("McpCardShell", () => {
  it("renders the title, children, and (when present) the badge", () => {
    render(
      <McpCardShell title="My Card" badge="3 items" testId="shell">
        <span>body</span>
      </McpCardShell>
    )
    expect(screen.getByTestId("shell")).toBeInTheDocument()
    expect(screen.getByText("My Card")).toBeInTheDocument()
    expect(screen.getByText("body")).toBeInTheDocument()
    expect(screen.getByTestId("shell-badge")).toHaveTextContent("3 items")
  })

  it("omits the badge when none is supplied", () => {
    render(
      <McpCardShell title="No Badge" testId="shell2">
        <span>x</span>
      </McpCardShell>
    )
    expect(screen.queryByTestId("shell2-badge")).not.toBeInTheDocument()
  })
})
