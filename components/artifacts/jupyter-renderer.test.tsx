/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

// CodeBlock pulls in shiki (ESM) which Jest can't load without extra config.
// We don't need real syntax highlighting here.
jest.mock("@/components/chat/renderers/code-block", () => ({
  CodeBlock: ({ code }: { code: string }) => <pre>{code}</pre>,
}))

jest.mock("@/components/chat/markdown-renderer", () => ({
  MarkdownRenderer: ({ content, rhythm }: { content: string; rhythm?: string }) => (
    <div data-testid="markdown-cell" data-rhythm={rhythm}>
      {content}
    </div>
  ),
}))

import { JupyterRenderer } from "./jupyter-renderer"
import { loggers } from "@cognia/logging"

const validNotebook = {
  cells: [
    { cell_type: "markdown", source: "# Hello\nSome text" },
    {
      cell_type: "code",
      source: "print('hi')",
      outputs: [{ output_type: "stream", name: "stdout", text: "hi\n" }],
    },
    {
      cell_type: "code",
      source: "raise ValueError('oops')",
      outputs: [
        {
          output_type: "error",
          ename: "ValueError",
          evalue: "oops",
          traceback: ["Traceback (most recent call last):", "  ValueError: oops"],
        },
      ],
    },
    {
      cell_type: "code",
      source: "html_view()",
      outputs: [
        {
          output_type: "display_data",
          data: { "text/html": "<b>html out</b>" },
        },
      ],
    },
    {
      cell_type: "code",
      source: "image_view()",
      outputs: [
        {
          output_type: "display_data",
          data: { "image/png": "iVBORw0KGgoAAAANSUhEUg==" },
        },
      ],
    },
    {
      cell_type: "code",
      source: "text_view()",
      outputs: [{ output_type: "execute_result", data: { "text/plain": "42" } }],
    },
    { cell_type: "raw", source: "raw cell content" },
  ],
  metadata: { kernelspec: { name: "python3", language: "python", display_name: "Python 3" } },
  nbformat: 4,
  nbformat_minor: 5,
}

describe("JupyterRenderer", () => {
  it("renders a parse-error alert for invalid JSON and logs a warning", () => {
    const warnSpy = jest.spyOn(loggers.ui, "warn").mockImplementation()
    render(<JupyterRenderer content="this is not json" />)
    expect(screen.getByText("notebookParseError")).toBeInTheDocument()
    expect(warnSpy).toHaveBeenCalledWith(
      "artifacts.jupyter.parse-failed",
      expect.objectContaining({ contentSize: expect.any(Number) })
    )
    warnSpy.mockRestore()
  })

  it("renders a parse-error alert when JSON has no cells array", () => {
    render(<JupyterRenderer content={JSON.stringify({ meta: 1 })} />)
    expect(screen.getByText("notebookParseError")).toBeInTheDocument()
  })

  it("renders all cell variants without crashing", () => {
    const { container } = render(<JupyterRenderer content={JSON.stringify(validNotebook)} />)
    expect(container.textContent).toContain("hi")
    expect(container.textContent).toContain("ValueError")
    expect(container.textContent).toContain("42")
    expect(screen.getByTestId("markdown-cell")).toHaveAttribute("data-rhythm", "document")
    const iframe = screen.getByTitle("notebookHtmlOutput")
    expect(iframe).toHaveAttribute("sandbox", "allow-popups")
    expect(iframe.getAttribute("srcdoc")).toContain("<b>html out</b>")
    expect(iframe.getAttribute("srcdoc")).toMatch(/Content-Security-Policy/i)
  })

  it("blocks active notebook HTML while retaining safe tables", () => {
    const notebook = {
      ...validNotebook,
      cells: [
        {
          cell_type: "code",
          source: "unsafe()",
          outputs: [
            {
              output_type: "display_data",
              data: {
                "text/html":
                  '<meta http-equiv="refresh" content="0;url=https://evil.example"><a href="https://safe.example" target="_blank" rel="noopener">safe link</a><table><tbody><tr><td>safe cell</td></tr></tbody></table><img src="data:image/png;base64,AA==" onerror="parent.location=\'https://evil.example\'"><form action="https://evil.example"><input></form><script>parent.location="https://evil.example"</script>',
              },
            },
          ],
        },
      ],
    }

    render(<JupyterRenderer content={JSON.stringify(notebook)} />)
    const srcDoc = screen.getByTitle("notebookHtmlOutput").getAttribute("srcdoc") ?? ""
    expect(srcDoc).toContain("<table")
    expect(srcDoc).toContain("safe cell")
    expect(srcDoc).toContain('href="https://safe.example"')
    expect(srcDoc).toContain('target="_blank"')
    expect(srcDoc).not.toMatch(
      /http-equiv="refresh"|onerror|<form|<input|<script|parent\.location/i
    )
  })
})
