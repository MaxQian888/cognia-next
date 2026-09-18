import { act, fireEvent, render, renderHook, screen } from "@testing-library/react"
import {
  blockMediaSrc,
  dateOf,
  parseOutputJson,
  hostOf,
  languageFromPath,
  PreviewClampNote,
  SourceFavicon,
  TOOL_LIST_MAX_ROWS,
  TOOL_PREVIEW_MAX_LINES,
  useClampedRows,
  useParsedOutput,
} from "./common"

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

describe("SourceFavicon", () => {
  it("renders the provider favicon when one is supplied", () => {
    const { container } = render(<SourceFavicon src="https://a.test/favicon.ico" host="a.test" />)
    expect(container.querySelector("img")).toHaveAttribute("src", "https://a.test/favicon.ico")
  })

  it("falls back to a letter chip when no favicon is supplied", () => {
    const { container } = render(<SourceFavicon host="example.com" />)
    expect(container.querySelector("img")).not.toBeInTheDocument()
    expect(container.firstChild).toHaveTextContent("E")
  })

  it("swaps to the letter chip when the favicon fails to load", () => {
    const { container } = render(<SourceFavicon src="https://a.test/broken.ico" host="a.test" />)
    fireEvent.error(container.querySelector("img")!)
    expect(container.querySelector("img")).not.toBeInTheDocument()
    expect(container.firstChild).toHaveTextContent("A")
  })

  it("renders a placeholder letter when the host is empty", () => {
    const { container } = render(<SourceFavicon host="" />)
    expect(container.firstChild).toHaveTextContent("?")
  })
})

describe("dateOf", () => {
  it("renders a parseable ISO date as YYYY-MM-DD", () => {
    expect(dateOf("2026-09-01T12:34:56Z")).toBe("2026-09-01")
  })

  it("returns null for missing or unparseable values", () => {
    expect(dateOf(undefined)).toBeNull()
    expect(dateOf("")).toBeNull()
    expect(dateOf("not a date")).toBeNull()
    expect(dateOf(42)).toBeNull()
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

describe("useClampedRows", () => {
  it("returns everything untouched when the list fits the budget", () => {
    const items = [1, 2, 3]
    const { result } = renderHook(() => useClampedRows(items, 10))
    expect(result.current.visible).toEqual([1, 2, 3])
    expect(result.current.hidden).toBe(0)
    expect(result.current.revealed).toBe(false)
    expect(result.current.total).toBe(3)
  })

  it("clamps to the budget and reveals the full list on reveal()", () => {
    const items = Array.from({ length: 300 }, (_, i) => `row-${i}`)
    const { result } = renderHook(() => useClampedRows(items, 200))
    expect(result.current.visible).toHaveLength(200)
    expect(result.current.hidden).toBe(100)
    expect(result.current.shown).toBe(200)
    act(() => result.current.reveal())
    expect(result.current.visible).toHaveLength(300)
    expect(result.current.hidden).toBe(0)
    expect(result.current.revealed).toBe(true)
  })

  it("defaults to the shared line budget", () => {
    const items = Array.from({ length: TOOL_PREVIEW_MAX_LINES + 5 }, (_, i) => i)
    const { result } = renderHook(() => useClampedRows(items))
    expect(result.current.visible).toHaveLength(TOOL_PREVIEW_MAX_LINES)
    expect(result.current.hidden).toBe(5)
  })
})

describe("PreviewClampNote", () => {
  it("renders the shown/total counts, optional hint, and fires onExpand", () => {
    const onExpand = jest.fn()
    render(
      <PreviewClampNote
        shown={120}
        total={843}
        onExpand={onExpand}
        hint="extra hint"
        testId="clamp"
      />
    )
    const note = screen.getByTestId("clamp")
    expect(note).toHaveTextContent("Showing the first 120 of 843")
    expect(note).toHaveTextContent("extra hint")
    fireEvent.click(screen.getByTestId("clamp-show-all"))
    expect(onExpand).toHaveBeenCalledTimes(1)
  })

  it("renders without a hint or test id", () => {
    render(<PreviewClampNote shown={5} total={9} onExpand={jest.fn()} />)
    expect(screen.getByText(/Showing the first 5 of 9/)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Show all" })).toBeInTheDocument()
  })
})

describe("TOOL_* budgets", () => {
  it("keeps the list budget looser than the code-line budget", () => {
    expect(TOOL_LIST_MAX_ROWS).toBeGreaterThan(TOOL_PREVIEW_MAX_LINES)
  })
})
