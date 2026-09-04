/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { ToolUIPart } from "ai"

const canOfferWorkbenchReview = jest.fn(() => true)
const openFileInWorkbenchWorkspace = jest.fn(async (_args: unknown) => true)

jest.mock("next-intl", () => ({
  useTranslations: (namespace: string) => (key: string) => `${namespace}.${key}`,
}))
jest.mock("@/lib/files/edit-review-bridge", () => ({
  canOfferWorkbenchReview: () => canOfferWorkbenchReview(),
  openFileInWorkbenchWorkspace: (args: unknown) => openFileInWorkbenchWorkspace(args),
}))

import { GlobCard } from "./glob-card"

function globPart(overrides: Partial<ToolUIPart>): ToolUIPart {
  return {
    type: "tool-Glob",
    toolCallId: "c1",
    state: "output-available",
    input: { pattern: "**/*.ts" },
    ...overrides,
  } as unknown as ToolUIPart
}

beforeEach(() => {
  jest.clearAllMocks()
  canOfferWorkbenchReview.mockReturnValue(true)
})

describe("GlobCard", () => {
  it("lists matches from a structured payload", () => {
    render(<GlobCard part={globPart({ output: { files: ["/repo/a.ts", "/repo/b.ts"] } })} />)
    expect(screen.getAllByTestId("mcp-glob-match")).toHaveLength(2)
    expect(screen.getByTestId("mcp-glob-pattern").textContent).toContain("**/*.ts")
  })

  it("splits a plain-string payload into one match per line", () => {
    render(<GlobCard part={globPart({ output: "/repo/a.ts\n/repo/b.ts\n" })} />)
    expect(screen.getAllByTestId("mcp-glob-match")).toHaveLength(2)
  })

  it("returns null with neither a pattern nor a match, so the caller can fall back", () => {
    const { container } = render(<GlobCard part={globPart({ input: {}, output: "" })} />)
    expect(container).toBeEmptyDOMElement()
  })

  it("says so instead of listing nothing when the pattern matched nothing", () => {
    render(<GlobCard part={globPart({ output: "" })} />)
    expect(screen.getByText("chat.mcp.glob.noMatches")).toBeInTheDocument()
  })

  it("makes each match reachable in the workspace panel", () => {
    render(
      <GlobCard
        sessionId="s1"
        part={globPart({ output: { files: ["/repo/a.ts", "/repo/b.ts"] } })}
      />
    )
    expect(screen.getAllByTestId("mcp-glob-match-link")).toHaveLength(2)
  })

  it("leaves the matches as plain text with no conversation to open them in", () => {
    render(<GlobCard part={globPart({ output: { files: ["/repo/a.ts"] } })} />)
    expect(screen.queryByTestId("mcp-glob-match-link")).toBeNull()
    expect(screen.getByTestId("mcp-glob-match").textContent).toBe("/repo/a.ts")
  })

  it("makes a relative match reachable, which is what Glob reports by default", async () => {
    render(<GlobCard sessionId="s1" part={globPart({ output: { files: ["src/a.ts"] } })} />)
    const link = screen.getByTestId("mcp-glob-match-link")
    expect(link).toHaveTextContent("src/a.ts")
    fireEvent.click(link)
    await waitFor(() =>
      expect(openFileInWorkbenchWorkspace).toHaveBeenCalledWith({
        sessionId: "s1",
        path: "src/a.ts",
        line: undefined,
        column: undefined,
      })
    )
  })
})
