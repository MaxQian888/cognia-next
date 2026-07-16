/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react"

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
    expect(search).toHaveBeenCalledWith("/repo", "needle", { maxResults: 200 })
    // Two files grouped.
    expect(screen.getByTestId("search-hit-src/a.ts-9")).toBeInTheDocument()
    expect(screen.getByTestId("search-hit-src/b.ts-4")).toBeInTheDocument()

    fireEvent.click(screen.getByTestId("search-hit-src/b.ts-4"))
    expect(onOpenMatch).toHaveBeenCalledWith("src/b.ts", 4, 3)
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

  it("swallows a search error without crashing", async () => {
    const search = jest.fn(async () => {
      throw new Error("boom")
    })
    render(<ProjectSearchPanel rootPath="/repo" onOpenMatch={jest.fn()} deps={{ search }} />)
    const input = screen.getByLabelText("search")
    fireEvent.change(input, { target: { value: "x" } })
    fireEvent.keyDown(input, { key: "Enter" })
    await waitFor(() => expect(screen.getByText("searchEmpty")).toBeInTheDocument())
  })
})
