import { render, screen } from "@testing-library/react"
import MarkdownViewer from "./markdown-viewer"
import type { FileViewerRenderProps } from "@/lib/file-viewer/types"

jest.mock("@/components/chat/markdown-renderer", () => ({
  MarkdownRenderer: ({ content, rhythm }: { content: string; rhythm?: string }) => (
    <div data-rhythm={rhythm}>{content}</div>
  ),
}))

describe("MarkdownViewer", () => {
  it("renders the file through the shared markdown renderer in document rhythm", () => {
    const props: FileViewerRenderProps = {
      text: "# Title",
      displayName: "notes.md",
      relPath: "notes.md",
      line: null,
      column: null,
      source: "project-preview",
    }
    render(<MarkdownViewer {...props} />)

    const pane = screen.getByTestId("project-markdown-preview")
    expect(pane).toHaveTextContent("# Title")
    // `document` rhythm is what both previous preview paths passed; chat
    // rhythm would tighten the spacing of a standalone file.
    expect(pane.firstChild).toHaveAttribute("data-rhythm", "document")
  })
})
