import { render, screen } from "@testing-library/react"
import { ProjectFilePreviewPanel } from "./project-file-preview-panel"

jest.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))
jest.mock("@/components/chat/markdown-renderer", () => ({
  MarkdownRenderer: ({ content }: { content: string }) => <article>{content}</article>,
}))

describe("ProjectFilePreviewPanel", () => {
  it("renders Markdown, HTML, and JSON through safe preview surfaces", () => {
    const { rerender } = render(<ProjectFilePreviewPanel relPath="README.md" content="# Hello" />)
    expect(screen.getByTestId("project-markdown-preview")).toHaveTextContent("# Hello")

    rerender(<ProjectFilePreviewPanel relPath="index.html" content="<h1>Hello</h1>" />)
    expect(screen.getByTestId("project-html-preview")).toHaveAttribute(
      "sandbox",
      "allow-forms allow-modals allow-popups allow-scripts"
    )

    rerender(<ProjectFilePreviewPanel relPath="data.json" content='{"a":1}' />)
    expect(screen.getByTestId("project-json-preview")).toHaveTextContent('"a": 1')
  })

  it("shows the explicit unavailable state for unsupported runtimes", () => {
    render(<ProjectFilePreviewPanel relPath="main.py" content="print('hello')" />)
    expect(screen.getByText("preview.title")).toBeInTheDocument()
  })
})
