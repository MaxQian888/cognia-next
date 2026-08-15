import { render, screen, waitFor } from "@testing-library/react"
import { ProjectFilePreviewPanel } from "./project-file-preview-panel"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))
jest.mock("@/components/chat/markdown-renderer", () => ({
  MarkdownRenderer: ({ content, rhythm }: { content: string; rhythm?: string }) => (
    <article data-testid="markdown-renderer" data-rhythm={rhythm}>
      {content}
    </article>
  ),
}))
// A faithful stand-in for `next/dynamic`: honours the loader (these assertions
// want the real viewers) and re-renders once it resolves, which the production
// implementation also does.
jest.mock("next/dynamic", () => {
  const react = jest.requireActual<typeof import("react")>("react")
  return (loader: () => Promise<{ default: React.ComponentType<Record<string, unknown>> }>) =>
    function Loaded(props: Record<string, unknown>) {
      const [Component, setComponent] = react.useState<React.ComponentType<
        Record<string, unknown>
      > | null>(null)
      react.useEffect(() => {
        let cancelled = false
        void loader().then((mod) => {
          if (!cancelled) setComponent(() => mod.default)
        })
        return () => {
          cancelled = true
        }
      }, [])
      return Component ? react.createElement(Component, props) : null
    }
})
// Nothing here may reach the filesystem: this panel previews the live draft.
const mockStat = jest.fn()
const mockRead = jest.fn()
jest.mock("@/lib/files/workspace-fs", () => ({
  statWorkspaceFile: (...a: unknown[]) => mockStat(...a),
  readWorkspaceFile: (...a: unknown[]) => mockRead(...a),
}))

describe("ProjectFilePreviewPanel", () => {
  it("renders Markdown, HTML, and JSON through the shared preview surface", async () => {
    const { rerender } = render(<ProjectFilePreviewPanel relPath="README.md" content="# Hello" />)
    await waitFor(() =>
      expect(screen.getByTestId("project-markdown-preview")).toHaveTextContent("# Hello")
    )
    expect(screen.getByTestId("markdown-renderer")).toHaveAttribute("data-rhythm", "document")

    rerender(<ProjectFilePreviewPanel relPath="index.html" content="<h1>Hello</h1>" />)
    await waitFor(() => expect(screen.getByTestId("project-html-preview")).toBeInTheDocument())

    rerender(<ProjectFilePreviewPanel relPath="data.json" content={'{"a":1}'} />)
    await waitFor(() =>
      expect(screen.getByTestId("project-json-preview")).toHaveTextContent('"a": 1')
    )
  })

  it("previews the draft without reading the file from disk", async () => {
    render(<ProjectFilePreviewPanel relPath="README.md" content="# Draft" />)
    await waitFor(() => expect(screen.getByTestId("project-markdown-preview")).toBeInTheDocument())

    // The point of passing the draft: an unsaved buffer must preview as the
    // user sees it, not as the file on disk still reads.
    expect(mockStat).not.toHaveBeenCalled()
    expect(mockRead).not.toHaveBeenCalled()
  })

  it("tightens the HTML sandbox that used to allow forms, modals and popups", async () => {
    render(<ProjectFilePreviewPanel relPath="index.html" content="<h1>Hello</h1>" />)
    const frame = await screen.findByTestId("project-html-preview")

    // Scripts stay — this is the user's own draft — but the frame can no longer
    // spawn windows, block the app with a modal, or reach the network.
    expect(frame).toHaveAttribute("sandbox", "allow-scripts")
    expect((frame as HTMLIFrameElement).srcdoc).toContain("connect-src \'none\'")
    expect(frame.getAttribute("sandbox")).not.toContain("allow-same-origin")
  })

  it("shows the explicit unavailable state for unsupported runtimes", () => {
    render(<ProjectFilePreviewPanel relPath="main.py" content="print('hello')" />)
    expect(screen.getByText("preview.title")).toBeInTheDocument()
  })
})
