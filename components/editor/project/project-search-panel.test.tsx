/**
 * @jest-environment jsdom
 */
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"

const mockTransportListeners = new Set<() => void>()
const mockRemoteListeners = new Set<() => void>()
jest.mock("@/lib/tauri/transport-instance", () => ({
  onTransportChange: (listener: () => void) => {
    mockTransportListeners.add(listener)
    return () => mockTransportListeners.delete(listener)
  },
}))
jest.mock("@/lib/tauri/transport-routing", () => ({
  subscribeActiveRemoteTransport: (listener: () => void) => {
    mockRemoteListeners.add(listener)
    return () => mockRemoteListeners.delete(listener)
  },
}))

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

    it("Enter cancels the pending debounce instead of sending the same query twice", async () => {
      const search = jest.fn(async () => matches)
      render(<ProjectSearchPanel rootPath="/repo" onOpenMatch={jest.fn()} deps={{ search }} />)
      const input = screen.getByLabelText("search")
      fireEvent.change(input, { target: { value: "needle" } })
      fireEvent.keyDown(input, { key: "Enter" })
      await act(async () => {
        await jest.advanceTimersByTimeAsync(1_000)
      })
      expect(search).toHaveBeenCalledTimes(1)
    })

    it("invalidates earlier results as soon as a query changes during the debounce", async () => {
      let resolve!: (results: WorkspaceContentMatch[]) => void
      const search = jest.fn(
        () =>
          new Promise<WorkspaceContentMatch[]>((done) => {
            resolve = done
          })
      )
      render(<ProjectSearchPanel rootPath="/repo" onOpenMatch={jest.fn()} deps={{ search }} />)
      const input = screen.getByLabelText("search")
      fireEvent.change(input, { target: { value: "old" } })
      fireEvent.keyDown(input, { key: "Enter" })
      fireEvent.change(input, { target: { value: "new" } })
      await act(async () => {
        resolve(matches)
      })
      expect(screen.queryByTestId("search-hit-src/a.ts-2")).toBeNull()
      expect(search).toHaveBeenCalledTimes(1)
    })

    it("preserves query and options while inactive, then refreshes and focuses on activation", async () => {
      const search = jest.fn(async () => matches)
      const props = { rootPath: "/repo", onOpenMatch: jest.fn(), deps: { search } }
      const { rerender } = render(<ProjectSearchPanel {...props} active />)
      const input = screen.getByLabelText("search")
      fireEvent.change(input, { target: { value: "needle" } })
      fireEvent.click(screen.getByTestId("search-case-toggle"))
      fireEvent.click(screen.getByTestId("search-regex-toggle"))
      rerender(<ProjectSearchPanel {...props} active={false} />)
      input.blur()
      await act(async () => {
        await jest.advanceTimersByTimeAsync(1_000)
      })
      expect(search).not.toHaveBeenCalled()
      expect(input).toHaveValue("needle")
      expect(screen.getByTestId("search-case-toggle")).toHaveAttribute("aria-pressed", "true")
      expect(screen.getByTestId("search-regex-toggle")).toHaveAttribute("aria-pressed", "true")
      rerender(<ProjectSearchPanel {...props} active />)
      expect(input).toHaveFocus()
      await act(async () => {
        await jest.advanceTimersByTimeAsync(250)
      })
      expect(search).toHaveBeenCalledTimes(1)
      expect(search).toHaveBeenCalledWith("/repo", "needle", {
        maxResults: 200,
        isRegex: true,
        caseSensitive: true,
      })
      expect(screen.getByTestId("search-hit-src/a.ts-2")).toBeInTheDocument()
    })

    it("ignores a late result while inactive and does not initially focus a hidden panel", async () => {
      let resolve!: (results: WorkspaceContentMatch[]) => void
      const search = jest.fn(
        () =>
          new Promise<WorkspaceContentMatch[]>((done) => {
            resolve = done
          })
      )
      const props = { rootPath: "/repo", onOpenMatch: jest.fn(), deps: { search } }
      const { rerender } = render(<ProjectSearchPanel {...props} active={false} />)
      const input = screen.getByLabelText("search")
      expect(input).not.toHaveFocus()
      rerender(<ProjectSearchPanel {...props} active />)
      fireEvent.change(input, { target: { value: "needle" } })
      fireEvent.keyDown(input, { key: "Enter" })
      rerender(<ProjectSearchPanel {...props} active={false} />)
      await act(async () => {
        resolve(matches)
        await jest.advanceTimersByTimeAsync(1_000)
      })
      expect(search).toHaveBeenCalledTimes(1)
      expect(screen.queryByTestId("search-hit-src/a.ts-2")).toBeNull()
    })

    it("retains completed results across hide/show and replaces them on refresh", async () => {
      const search = jest.fn(async () => matches)
      const props = { rootPath: "/repo", onOpenMatch: jest.fn(), deps: { search } }
      const { rerender } = render(<ProjectSearchPanel {...props} active />)
      fireEvent.change(screen.getByLabelText("search"), { target: { value: "needle" } })
      await act(async () => {
        await jest.advanceTimersByTimeAsync(250)
      })
      rerender(<ProjectSearchPanel {...props} active={false} />)
      await act(async () => {
        await jest.advanceTimersByTimeAsync(5_000)
      })
      expect(screen.getByTestId("search-hit-src/a.ts-2")).toBeInTheDocument()
      expect(search).toHaveBeenCalledTimes(1)
      search.mockResolvedValueOnce([])
      rerender(<ProjectSearchPanel {...props} active />)
      await act(async () => {
        await jest.advanceTimersByTimeAsync(250)
      })
      expect(search).toHaveBeenCalledTimes(2)
      expect(screen.queryByTestId("search-hit-src/a.ts-2")).toBeNull()
    })

    it.each(["transport", "remote"])(
      "invalidates %s host results and resumes the retained query on the current root",
      async (source) => {
        let resolve!: (results: WorkspaceContentMatch[]) => void
        const search = jest.fn(
          () =>
            new Promise<WorkspaceContentMatch[]>((done) => {
              resolve = done
            })
        )
        const props = { rootPath: "/repo", onOpenMatch: jest.fn(), deps: { search } }
        const { rerender, unmount } = render(<ProjectSearchPanel {...props} active />)
        fireEvent.change(screen.getByLabelText("search"), { target: { value: "needle" } })
        fireEvent.keyDown(screen.getByLabelText("search"), { key: "Enter" })
        rerender(<ProjectSearchPanel {...props} active={false} />)
        act(() => {
          for (const listener of source === "transport"
            ? mockTransportListeners
            : mockRemoteListeners)
            listener()
        })
        await act(async () => {
          resolve(matches)
          await jest.advanceTimersByTimeAsync(250)
        })
        expect(search).toHaveBeenCalledTimes(1)
        expect(screen.queryByTestId("search-hit-src/a.ts-2")).toBeNull()
        rerender(<ProjectSearchPanel {...props} rootPath="/current" active />)
        await act(async () => {
          await jest.advanceTimersByTimeAsync(250)
        })
        expect(search).toHaveBeenLastCalledWith("/current", "needle", {
          maxResults: 200,
          caseSensitive: false,
          isRegex: false,
        })
        unmount()
        expect(mockTransportListeners.size).toBe(0)
        expect(mockRemoteListeners.size).toBe(0)
      }
    )

    it("discards active-host completions before the replacement host query starts", async () => {
      let resolve!: (results: WorkspaceContentMatch[]) => void
      const search = jest.fn(
        () =>
          new Promise<WorkspaceContentMatch[]>((done) => {
            resolve = done
          })
      )
      render(<ProjectSearchPanel rootPath="/repo" onOpenMatch={jest.fn()} deps={{ search }} />)
      fireEvent.change(screen.getByLabelText("search"), { target: { value: "needle" } })
      fireEvent.keyDown(screen.getByLabelText("search"), { key: "Enter" })
      act(() => {
        for (const listener of mockTransportListeners) listener()
      })
      await act(async () => {
        resolve(matches)
      })
      expect(search).toHaveBeenCalledTimes(1)
      expect(screen.queryByTestId("search-hit-src/a.ts-2")).toBeNull()
      await act(async () => {
        await jest.advanceTimersByTimeAsync(250)
      })
      expect(search).toHaveBeenCalledTimes(2)
    })

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

describe("scoped search (Find in Folder)", () => {
  it("searches under the scope root and re-prefixes result paths", async () => {
    // The backend is scoped — it reports paths relative to the folder.
    const search = jest.fn(async () => [
      { relPath: "a.ts", absolutePath: "/repo/src/a.ts", line: 2, column: 1, preview: "hit" },
    ])
    const onOpenMatch = jest.fn()
    render(
      <ProjectSearchPanel
        rootPath="/repo"
        onOpenMatch={onOpenMatch}
        deps={{ search }}
        scopeRelPath="src"
        onClearScope={jest.fn()}
      />
    )
    const input = screen.getByLabelText("search")
    fireEvent.change(input, { target: { value: "needle" } })
    fireEvent.keyDown(input, { key: "Enter" })
    await waitFor(() => expect(screen.getByTestId("search-hit-src/a.ts-2")).toBeInTheDocument())
    // The query went to the folder, not the workspace root…
    expect(search).toHaveBeenCalledWith("/repo/src", "needle", expect.objectContaining({}))
    // …but navigation and display stay workspace-relative.
    fireEvent.click(screen.getByTestId("search-hit-src/a.ts-2"))
    expect(onOpenMatch).toHaveBeenCalledWith("src/a.ts", 2, 1)
  })

  it("shows the scope chip and clears it", async () => {
    const onClearScope = jest.fn()
    render(
      <ProjectSearchPanel
        rootPath="/repo"
        onOpenMatch={jest.fn()}
        deps={{ search: jest.fn(async () => []) }}
        scopeRelPath="src/deep"
        onClearScope={onClearScope}
      />
    )
    expect(screen.getByText("searchScope")).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("search-scope-clear"))
    expect(onClearScope).toHaveBeenCalled()
  })
})

describe("result context menus", () => {
  async function runSearch(over: Partial<Parameters<typeof ProjectSearchPanel>[0]> = {}) {
    const search = jest.fn(async () => matches)
    render(
      <ProjectSearchPanel rootPath="/repo" onOpenMatch={jest.fn()} deps={{ search }} {...over} />
    )
    const input = screen.getByLabelText("search")
    fireEvent.change(input, { target: { value: "needle" } })
    fireEvent.keyDown(input, { key: "Enter" })
    await waitFor(() => expect(screen.getByTestId("search-hit-src/a.ts-2")).toBeInTheDocument())
  }

  it("a file-group menu reveals the file and copies both path forms", async () => {
    const onRevealInExplorer = jest.fn()
    const onCopyPath = jest.fn()
    await runSearch({ onRevealInExplorer, onCopyPath })
    const header = screen.getByText("src/b.ts").parentElement!
    fireEvent.contextMenu(header)
    const menu = await screen.findByTestId("search-file-menu-src/b.ts")
    fireEvent.click(within(menu).getByText("action.revealInExplorer"))
    expect(onRevealInExplorer).toHaveBeenCalledWith("src/b.ts")
    fireEvent.contextMenu(header)
    const menu2 = await screen.findByTestId("search-file-menu-src/b.ts")
    fireEvent.click(within(menu2).getByText("action.copyRelativePath"))
    expect(onCopyPath).toHaveBeenCalledWith("src/b.ts", false)
    fireEvent.contextMenu(header)
    const menu3 = await screen.findByTestId("search-file-menu-src/b.ts")
    fireEvent.click(within(menu3).getByText("action.copyPath"))
    expect(onCopyPath).toHaveBeenCalledWith("src/b.ts", true)
  })

  it("a hit menu copies the location line to the clipboard", async () => {
    const writeText = jest.fn(async () => {})
    Object.assign(navigator, { clipboard: { writeText } })
    await runSearch()
    fireEvent.contextMenu(screen.getByTestId("search-hit-src/a.ts-2"))
    const menu = await screen.findByTestId("search-hit-menu-src/a.ts-2")
    fireEvent.click(within(menu).getByText("action.copy"))
    expect(writeText).toHaveBeenCalledWith("src/a.ts:2:7: const needle")
  })
})
