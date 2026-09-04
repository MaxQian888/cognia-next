/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react"

const canOfferWorkbenchReview = jest.fn(() => true)
const openFileInWorkbenchWorkspace = jest.fn<Promise<boolean>, [unknown]>()
const toastError = jest.fn()

jest.mock("next-intl", () => ({
  useTranslations: (namespace: string) => (key: string) => `${namespace}.${key}`,
}))
jest.mock("sonner", () => ({ toast: { error: (...args: unknown[]) => toastError(...args) } }))
jest.mock("@/lib/files/edit-review-bridge", () => ({
  canOfferWorkbenchReview: () => canOfferWorkbenchReview(),
  openFileInWorkbenchWorkspace: (args: unknown) => openFileInWorkbenchWorkspace(args),
}))

import { WorkbenchFileLink } from "./workbench-file-link"

beforeEach(() => {
  jest.clearAllMocks()
  canOfferWorkbenchReview.mockReturnValue(true)
  openFileInWorkbenchWorkspace.mockResolvedValue(true)
})

describe("WorkbenchFileLink", () => {
  it("reveals the file in the workspace panel, carrying the caret", async () => {
    render(<WorkbenchFileLink sessionId="s1" path="/repo/src/a.ts" line={42} column={3} />)
    fireEvent.click(screen.getByTestId("mcp-workbench-file-link"))
    await waitFor(() =>
      expect(openFileInWorkbenchWorkspace).toHaveBeenCalledWith({
        sessionId: "s1",
        path: "/repo/src/a.ts",
        line: 42,
        column: 3,
      })
    )
    expect(toastError).not.toHaveBeenCalled()
  })

  it("says so rather than swallowing a path outside the conversation's tree", async () => {
    openFileInWorkbenchWorkspace.mockResolvedValue(false)
    render(<WorkbenchFileLink sessionId="s1" path="/elsewhere/a.ts" />)
    fireEvent.click(screen.getByTestId("mcp-workbench-file-link"))
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith("chat.mcp.openInWorkspaceOutOfScope")
    )
  })

  it("renders plain text with no conversation to open it in", () => {
    render(<WorkbenchFileLink path="/repo/src/a.ts" />)
    expect(screen.queryByTestId("mcp-workbench-file-link")).toBeNull()
    expect(screen.getByText("/repo/src/a.ts")).toBeInTheDocument()
  })

  it("renders plain text in pure web mode, where there is no working tree", () => {
    canOfferWorkbenchReview.mockReturnValue(false)
    render(<WorkbenchFileLink sessionId="s1" path="/repo/src/a.ts" />)
    expect(screen.queryByTestId("mcp-workbench-file-link")).toBeNull()
  })

  it("links a relative path, which the bridge resolves against the execution root", async () => {
    // `Read` accepts a relative `file_path` and `Glob`/`Grep` emit relative
    // paths by default, so refusing them here left most tool-card paths inert.
    render(<WorkbenchFileLink sessionId="s1" path="src/a.ts" line={4} />)
    fireEvent.click(screen.getByTestId("mcp-workbench-file-link"))
    await waitFor(() =>
      expect(openFileInWorkbenchWorkspace).toHaveBeenCalledWith({
        sessionId: "s1",
        path: "src/a.ts",
        line: 4,
        column: undefined,
      })
    )
  })

  it("reports a relative path that resolves outside the tree instead of swallowing it", async () => {
    openFileInWorkbenchWorkspace.mockResolvedValue(false)
    render(<WorkbenchFileLink sessionId="s1" path="../elsewhere/a.ts" />)
    fireEvent.click(screen.getByTestId("mcp-workbench-file-link"))
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith("chat.mcp.openInWorkspaceOutOfScope")
    )
  })

  it("renders plain text for a blank path, which names nothing to open", () => {
    render(<WorkbenchFileLink sessionId="s1" path="   " />)
    expect(screen.queryByTestId("mcp-workbench-file-link")).toBeNull()
  })

  it("takes a Windows path as absolute", () => {
    render(<WorkbenchFileLink sessionId="s1" path="C:\\repo\\a.ts" />)
    expect(screen.getByTestId("mcp-workbench-file-link")).toBeInTheDocument()
  })

  it("shows a caller's own label over the raw path", () => {
    render(
      <WorkbenchFileLink sessionId="s1" path="/repo/src/a.ts">
        a.ts
      </WorkbenchFileLink>
    )
    expect(screen.getByTestId("mcp-workbench-file-link")).toHaveTextContent("a.ts")
  })

  it("names the file in its accessible name, not just the action", () => {
    // A Grep card renders one of these per match. A bare "Open in the workspace
    // panel" label replaces the visible path, so every row announces the same
    // sentence and a screen-reader user cannot tell which link is which.
    render(<WorkbenchFileLink sessionId="s1" path="/repo/src/a.ts" />)

    const link = screen.getByTestId("mcp-workbench-file-link")
    expect(link).toHaveAccessibleName(expect.stringContaining("/repo/src/a.ts"))
    expect(link).toHaveAccessibleName(expect.stringContaining("chat.mcp.openInWorkspace"))
  })
})
