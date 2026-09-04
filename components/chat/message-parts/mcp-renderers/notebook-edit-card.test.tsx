/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { ToolUIPart } from "ai"

const canOfferWorkbenchReview = jest.fn(() => true)
const openFileInWorkbenchWorkspace = jest.fn(async (_args: unknown) => true)

jest.mock("@/components/chat/renderers/code-block", () => ({
  CodeBlock: ({ code, language }: { code: string; language?: string }) => (
    <pre data-testid="code" data-language={language}>
      {code}
    </pre>
  ),
}))
jest.mock("next-intl", () => ({
  useTranslations: (namespace: string) => (key: string) => `${namespace}.${key}`,
}))
jest.mock("@/lib/files/edit-review-bridge", () => ({
  canOfferWorkbenchReview: () => canOfferWorkbenchReview(),
  openFileInWorkbenchWorkspace: (args: unknown) => openFileInWorkbenchWorkspace(args),
}))

import { NotebookEditCard } from "./notebook-edit-card"

function notebookPart(input: Record<string, unknown>): ToolUIPart {
  return {
    type: "tool-NotebookEdit",
    toolCallId: "c1",
    state: "output-available",
    input,
  } as unknown as ToolUIPart
}

beforeEach(() => {
  jest.clearAllMocks()
  canOfferWorkbenchReview.mockReturnValue(true)
})

describe("NotebookEditCard", () => {
  it("returns null without a notebook path, so the caller can fall back", () => {
    const { container } = render(<NotebookEditCard part={notebookPart({})} />)
    expect(container).toBeEmptyDOMElement()
  })

  it("highlights a markdown cell as markdown and a code cell as python", () => {
    const { unmount } = render(
      <NotebookEditCard
        part={notebookPart({
          notebook_path: "/repo/n.ipynb",
          cell_type: "markdown",
          new_source: "# hi",
        })}
      />
    )
    expect(screen.getByTestId("code")).toHaveAttribute("data-language", "markdown")
    unmount()

    render(
      <NotebookEditCard
        part={notebookPart({ notebook_path: "/repo/n.ipynb", new_source: "x = 1" })}
      />
    )
    expect(screen.getByTestId("code")).toHaveAttribute("data-language", "python")
  })

  it("reports the edit mode, cell type and cell id together", () => {
    render(
      <NotebookEditCard
        part={notebookPart({
          notebook_path: "/repo/n.ipynb",
          edit_mode: "replace",
          cell_type: "code",
          cell_id: "c7",
        })}
      />
    )
    expect(screen.getByText("replace · code · cell c7")).toBeInTheDocument()
  })

  it("makes the notebook reachable in the workspace panel", () => {
    render(
      <NotebookEditCard sessionId="s1" part={notebookPart({ notebook_path: "/repo/n.ipynb" })} />
    )
    expect(screen.getByTestId("mcp-notebookedit-path-link")).toHaveTextContent("/repo/n.ipynb")
  })

  it("leaves the path as plain text with no conversation to open it in", () => {
    render(<NotebookEditCard part={notebookPart({ notebook_path: "/repo/n.ipynb" })} />)
    expect(screen.queryByTestId("mcp-notebookedit-path-link")).toBeNull()
    expect(screen.getByTestId("mcp-notebookedit-path").textContent).toBe("/repo/n.ipynb")
  })

  it("makes a relative notebook_path reachable", async () => {
    render(<NotebookEditCard sessionId="s1" part={notebookPart({ notebook_path: "nb/n.ipynb" })} />)
    const link = screen.getByTestId("mcp-notebookedit-path-link")
    expect(link).toHaveTextContent("nb/n.ipynb")
    fireEvent.click(link)
    await waitFor(() =>
      expect(openFileInWorkbenchWorkspace).toHaveBeenCalledWith({
        sessionId: "s1",
        path: "nb/n.ipynb",
        line: undefined,
        column: undefined,
      })
    )
  })
})
