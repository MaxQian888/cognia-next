/**
 * @jest-environment jsdom
 */
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

import { ProjectSearchPanel } from "./project-search-panel"
import type { WorkspaceContentMatch } from "@/lib/files/types"

const matches: WorkspaceContentMatch[] = [
  {
    relPath: "src/a.ts",
    absolutePath: "/repo/src/a.ts",
    line: 2,
    column: 7,
    preview: "const needle",
  },
  {
    relPath: "src/a.ts",
    absolutePath: "/repo/src/a.ts",
    line: 9,
    column: 1,
    preview: "needle again",
  },
  { relPath: "src/b.ts", absolutePath: "/repo/src/b.ts", line: 4, column: 3, preview: "x needle" },
]

describe("ProjectSearchPanel", () => {
  it("searches on Enter, groups by file, and opens a match", async () => {
    const search = jest.fn(async () => matches)
    const onOpenMatch = jest.fn()
    render(<ProjectSearchPanel rootPath="/repo" onOpenMatch={onOpenMatch} deps={{ search }} />)
    const input = screen.getByLabelText("search")
    fireEvent.change(input, { target: { value: "needle" } })
    fireEvent.keyDown(input, { key: "Enter" })

    await waitFor(() => expect(screen.getByTestId("search-hit-src/a.ts-2")).toBeInTheDocument())
    expect(search).toHaveBeenCalledWith("/repo", "needle", {
      maxResults: 200,
      isRegex: false,
      caseSensitive: false,
    })
    // Two files grouped, each sticky header carrying its own match count.
    expect(screen.getByTestId("search-hit-src/a.ts-9")).toBeInTheDocument()
    expect(screen.getByTestId("search-hit-src/b.ts-4")).toBeInTheDocument()
    const groupA = screen.getByText("src/a.ts").parentElement
    const groupB = screen.getByText("src/b.ts").parentElement
    expect(groupA && within(groupA).getByText("2")).toBeInTheDocument()
    expect(groupB && within(groupB).getByText("1")).toBeInTheDocument()

    fireEvent.click(screen.getByTestId("search-hit-src/b.ts-4"))
    expect(onOpenMatch).toHaveBeenCalledWith("src/b.ts", 4, 3)
  })

  it("uses touch-sized search controls in touch density", async () => {
    const search = jest.fn(async () => matches)
    render(
      <ProjectSearchPanel
        rootPath="/repo"
        onOpenMatch={jest.fn()}
        deps={{ search }}
        density="touch"
      />
    )
    const input = screen.getByLabelText("search")
    expect(input).toHaveClass("h-11")
    fireEvent.change(input, { target: { value: "needle" } })
    fireEvent.keyDown(input, { key: "Enter" })
    await waitFor(() => expect(screen.getByTestId("search-hit-src/a.ts-2")).toHaveClass("min-h-11"))
  })

  it("does not search for an empty query", async () => {
    const search = jest.fn(async () => [])
    render(<ProjectSearchPanel rootPath="/repo" onOpenMatch={jest.fn()} deps={{ search }} />)
    const input = screen.getByLabelText("search")
    fireEvent.change(input, { target: { value: "   " } })
    fireEvent.keyDown(input, { key: "Enter" })
    await waitFor(() => expect(search).not.toHaveBeenCalled())
  })

  it("shows the empty state when a search returns nothing", async () => {
    const search = jest.fn(async () => [])
    render(<ProjectSearchPanel rootPath="/repo" onOpenMatch={jest.fn()} deps={{ search }} />)
    const input = screen.getByLabelText("search")
    fireEvent.change(input, { target: { value: "zzz" } })
    fireEvent.keyDown(input, { key: "Enter" })
    await waitFor(() => expect(screen.getByText("searchEmpty")).toBeInTheDocument())
  })

  it("surfaces a search error instead of silently swallowing it", async () => {
    const search = jest.fn(async () => {
      throw new Error("boom")
    })
    render(<ProjectSearchPanel rootPath="/repo" onOpenMatch={jest.fn()} deps={{ search }} />)
    const input = screen.getByLabelText("search")
    fireEvent.change(input, { target: { value: "x" } })
    fireEvent.keyDown(input, { key: "Enter" })
    await waitFor(() => expect(screen.getByTestId("search-error")).toHaveTextContent("boom"))
  })

  describe("live search", () => {
    beforeEach(() => jest.useFakeTimers())
    afterEach(() => jest.useRealTimers())

    it("debounces keystrokes into a single query", async () => {
      const search = jest.fn(async () => matches)
      render(<ProjectSearchPanel rootPath="/repo" onOpenMatch={jest.fn()} deps={{ search }} />)
      const input = screen.getByLabelText("search")
      fireEvent.change(input, { target: { value: "n" } })
      fireEvent.change(input, { target: { value: "ne" } })
      fireEvent.change(input, { target: { value: "needle" } })
      await act(async () => {
        await jest.advanceTimersByTimeAsync(250)
      })
      expect(search).toHaveBeenCalledTimes(1)
      expect(search).toHaveBeenCalledWith("/repo", "needle", {
        maxResults: 200,
        isRegex: false,
        caseSensitive: false,
      })
      expect(screen.getByTestId("search-hit-src/a.ts-2")).toBeInTheDocument()
    })

    it("forwards the case-sensitive and regex switches", async () => {
      const search = jest.fn(async () => matches)
      render(<ProjectSearchPanel rootPath="/repo" onOpenMatch={jest.fn()} deps={{ search }} />)
      const input = screen.getByLabelText("search")
      fireEvent.change(input, { target: { value: "foo.*" } })
      fireEvent.click(screen.getByTestId("search-case-toggle"))
      fireEvent.click(screen.getByTestId("search-regex-toggle"))
      expect(screen.getByTestId("search-case-toggle")).toHaveAttribute("aria-pressed", "true")
      expect(screen.getByTestId("search-regex-toggle")).toHaveAttribute("aria-pressed", "true")
      fireEvent.keyDown(input, { key: "Enter" })
      await act(async () => {})
      expect(search).toHaveBeenCalledWith("/repo", "foo.*", {
        maxResults: 200,
        isRegex: true,
        caseSensitive: true,
      })
    })

    it("clears the query from Escape and the clear button", async () => {
      const search = jest.fn(async () => matches)
      render(<ProjectSearchPanel rootPath="/repo" onOpenMatch={jest.fn()} deps={{ search }} />)
      const input = screen.getByLabelText("search")
      expect(screen.queryByTestId("search-clear")).toBeNull()
      fireEvent.change(input, { target: { value: "abc" } })
      fireEvent.keyDown(input, { key: "Escape" })
      expect(input).toHaveValue("")
      fireEvent.change(input, { target: { value: "abc" } })
      fireEvent.click(screen.getByTestId("search-clear"))
      expect(input).toHaveValue("")
      expect(screen.queryByTestId("search-clear")).toBeNull()
    })

    it("reports the grouped hit count after results land", async () => {
      const search = jest.fn(async () => matches)
      render(<ProjectSearchPanel rootPath="/repo" onOpenMatch={jest.fn()} deps={{ search }} />)
      const input = screen.getByLabelText("search")
      fireEvent.change(input, { target: { value: "needle" } })
      fireEvent.keyDown(input, { key: "Enter" })
      await act(async () => {})
      expect(screen.getByTestId("search-count")).toBeInTheDocument()
    })

    it("a stale in-flight search can't paint over a newer one", async () => {
      const resolvers: Array<(m: WorkspaceContentMatch[]) => void> = []
      const search = jest.fn((_root: string, _q: string, _o: unknown) => {
        return new Promise<WorkspaceContentMatch[]>((resolve) => resolvers.push(resolve))
      })
      render(<ProjectSearchPanel rootPath="/repo" onOpenMatch={jest.fn()} deps={{ search }} />)
      const input = screen.getByLabelText("search")
      fireEvent.change(input, { target: { value: "first" } })
      fireEvent.keyDown(input, { key: "Enter" })
      fireEvent.change(input, { target: { value: "second" } })
      fireEvent.keyDown(input, { key: "Enter" })
      expect(search).toHaveBeenCalledTimes(2)

      // The newer query resolves first — its results paint.
      await act(async () => {
        resolvers[1]([
          { relPath: "new.ts", absolutePath: "/repo/new.ts", line: 1, column: 1, preview: "y" },
        ])
      })
      expect(screen.getByTestId("search-hit-new.ts-1")).toBeInTheDocument()

      // The stale query resolves late — the guard must drop it.
      await act(async () => {
        resolvers[0]([
          { relPath: "old.ts", absolutePath: "/repo/old.ts", line: 1, column: 1, preview: "x" },
        ])
      })
      expect(screen.queryByTestId("search-hit-old.ts-1")).toBeNull()
      expect(screen.getByTestId("search-hit-new.ts-1")).toBeInTheDocument()
    })
  })
})
