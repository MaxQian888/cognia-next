/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"
import type { ToolUIPart } from "ai"

const canOfferWorkbenchReview = jest.fn(() => true)

jest.mock("next-intl", () => ({
  useTranslations: (namespace: string) => (key: string) => `${namespace}.${key}`,
}))
jest.mock("@/lib/files/edit-review-bridge", () => ({
  canOfferWorkbenchReview: () => canOfferWorkbenchReview(),
  openFileInWorkbenchWorkspace: jest.fn(async () => true),
}))

import { GrepCard, splitGrepMatch } from "./grep-card"

function grepPart(overrides: Partial<ToolUIPart>): ToolUIPart {
  return {
    type: "tool-Grep",
    toolCallId: "c1",
    state: "output-available",
    input: { pattern: "TODO" },
    ...overrides,
  } as unknown as ToolUIPart
}

beforeEach(() => {
  jest.clearAllMocks()
  canOfferWorkbenchReview.mockReturnValue(true)
})

describe("splitGrepMatch", () => {
  it("reads content mode: path, line, and the matched text", () => {
    expect(splitGrepMatch("/repo/src/a.ts:42:  const x = 1")).toEqual({
      path: "/repo/src/a.ts",
      line: 42,
      rest: ":42:  const x = 1",
    })
  })

  it("reads files-with-matches mode: the bare path", () => {
    expect(splitGrepMatch("/repo/src/a.ts")).toEqual({
      path: "/repo/src/a.ts",
      line: undefined,
      rest: "",
    })
  })

  it("reads a Windows path without mistaking the drive for a line number", () => {
    expect(splitGrepMatch("C:\\repo\\a.ts:7:hit")).toEqual({
      path: "C:\\repo\\a.ts",
      line: 7,
      rest: ":7:hit",
    })
  })

  it("reads a relative content-mode line, which is what Grep reports by default", () => {
    expect(splitGrepMatch("src/a.ts:1:x")).toEqual({
      path: "src/a.ts",
      line: 1,
      rest: ":1:x",
    })
  })

  it("reads a relative bare path, and one with no directory but an extension", () => {
    expect(splitGrepMatch("src/a.ts")).toEqual({ path: "src/a.ts", line: undefined, rest: "" })
    expect(splitGrepMatch("README.md:3:hit")).toEqual({
      path: "README.md",
      line: 3,
      rest: ":3:hit",
    })
  })

  it("reads a relative count-mode line as a path with its total", () => {
    expect(splitGrepMatch("src/a.ts:12")).toEqual({ path: "src/a.ts", line: 12, rest: ":12" })
  })

  it("declines prose, grouped-output separators, and heading-mode body lines", () => {
    expect(splitGrepMatch("12 matches")).toBeNull()
    expect(splitGrepMatch("--")).toBeNull()
    // Heading mode prints the file once, then `line:text` rows whose head is a
    // bare number — linking those would point at a file called "42".
    expect(splitGrepMatch("42:  const x = 1")).toBeNull()
    expect(splitGrepMatch("Found 3 files")).toBeNull()
    expect(splitGrepMatch("")).toBeNull()
  })

  it("keeps a spaced absolute path whole, where the root already proves it is one", () => {
    expect(splitGrepMatch("/repo/my file.ts:2:hit")).toEqual({
      path: "/repo/my file.ts",
      line: 2,
      rest: ":2:hit",
    })
  })
})

describe("GrepCard", () => {
  it("shows the pattern with its scope and output mode", () => {
    render(
      <GrepCard
        part={grepPart({
          input: { pattern: "TODO", path: "/repo/src", output_mode: "content" },
          output: "/repo/src/a.ts:1:TODO",
        })}
      />
    )
    const header = screen.getByTestId("mcp-grep-pattern").textContent
    expect(header).toContain("TODO")
    expect(header).toContain("/repo/src")
    expect(header).toContain("content")
  })

  it("returns null with neither a pattern nor a match, so the caller can fall back", () => {
    const { container } = render(<GrepCard part={grepPart({ input: {}, output: "" })} />)
    expect(container).toBeEmptyDOMElement()
  })

  it("says so instead of listing nothing when the pattern matched nothing", () => {
    render(<GrepCard part={grepPart({ output: "" })} />)
    expect(screen.getByText("chat.mcp.grep.noMatches")).toBeInTheDocument()
  })

  it("links the file half of a match and leaves the matched text alone", () => {
    render(
      <GrepCard sessionId="s1" part={grepPart({ output: "/repo/src/a.ts:42:  const x = 1" })} />
    )
    expect(screen.getByTestId("mcp-grep-match-link")).toHaveTextContent("/repo/src/a.ts")
    expect(screen.getByTestId("mcp-grep-match").textContent).toBe("/repo/src/a.ts:42:  const x = 1")
  })

  it("leaves a count-mode total as plain text", () => {
    render(<GrepCard sessionId="s1" part={grepPart({ output: "12 matches" })} />)
    expect(screen.queryByTestId("mcp-grep-match-link")).toBeNull()
    expect(screen.getByTestId("mcp-grep-match").textContent).toBe("12 matches")
  })

  it("links the relative path Grep reports by default", () => {
    render(<GrepCard sessionId="s1" part={grepPart({ output: "src/a.ts:42:  const x = 1" })} />)
    expect(screen.getByTestId("mcp-grep-match-link")).toHaveTextContent("src/a.ts")
    expect(screen.getByTestId("mcp-grep-match").textContent).toBe("src/a.ts:42:  const x = 1")
  })
})
