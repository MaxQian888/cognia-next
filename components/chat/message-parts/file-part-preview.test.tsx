/**
 * @jest-environment jsdom
 */
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { FilePartPreview } from "./file-part-preview"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))
jest.mock("@/components/chat/renderers/code-block", () => ({
  CodeBlock: ({ code, language }: { code: string; language?: string }) => (
    <pre data-testid="code-block" data-language={language}>
      {code}
    </pre>
  ),
}))
jest.mock("@/components/chat/markdown-renderer", () => ({
  MarkdownRenderer: ({ content, rhythm }: { content: string; rhythm?: "chat" | "document" }) => (
    <article data-testid="markdown-preview" data-rhythm={rhythm}>
      {content}
    </article>
  ),
}))

const fetchMock = jest.fn()
beforeEach(() => {
  fetchMock.mockReset()
  global.fetch = fetchMock as unknown as typeof fetch
})
afterEach(() => {
  jest.restoreAllMocks()
})

describe("FilePartPreview", () => {
  it("renders a download link for an unknown/binary type", () => {
    render(
      <FilePartPreview url="blob:abc" mediaType="application/octet-stream" filename="data.bin" />
    )
    expect(screen.getByTestId("file-download-link")).toHaveTextContent("data.bin")
    expect(screen.queryByTestId("file-preview-text")).toBeNull()
  })

  it("embeds a PDF with a download fallback", () => {
    render(<FilePartPreview url="blob:pdf" mediaType="application/pdf" filename="doc.pdf" />)
    expect(screen.getByTestId("file-preview-pdf")).toBeInTheDocument()
    // fallback download link is present inside the <object>
    expect(screen.getByTestId("file-download-link")).toHaveTextContent("doc.pdf")
  })

  it("fetches and shows text content via CodeBlock with inferred language", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      text: () => Promise.resolve("export const x = 1\n"),
    } as Response)
    render(<FilePartPreview url="blob:code" mediaType="text/plain" filename="x.ts" />)
    await waitFor(() => expect(screen.getByTestId("file-preview-text")).toBeInTheDocument())
    const cb = screen.getByTestId("code-block")
    expect(cb.textContent).toContain("export const x = 1")
    expect(cb.dataset.language).toBe("typescript")
  })

  it("falls back to a download link when the text fetch fails", async () => {
    fetchMock.mockRejectedValue(new Error("boom"))
    render(<FilePartPreview url="blob:bad" mediaType="text/plain" filename="x.txt" />)
    await waitFor(() => expect(screen.getByTestId("file-download-link")).toBeInTheDocument())
  })

  it("treats a code extension without a text media type as text-like", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      text: () => Promise.resolve("print('hi')"),
    } as Response)
    render(<FilePartPreview url="blob:py" filename="script.py" />)
    await waitFor(() => expect(screen.getByTestId("code-block").dataset.language).toBe("python"))
  })

  it.each([
    ["text/markdown", "notes.txt"],
    ["text/plain", "notes.md"],
    ["application/octet-stream", "notes.mdx"],
  ])("renders Markdown by default for %s / %s", async (mediaType, filename) => {
    fetchMock.mockResolvedValue({
      ok: true,
      text: () => Promise.resolve("# Notes"),
    } as Response)

    render(<FilePartPreview url={"blob:" + filename} mediaType={mediaType} filename={filename} />)

    const preview = await screen.findByTestId("markdown-preview")
    expect(preview).toHaveTextContent("# Notes")
    expect(preview).toHaveAttribute("data-rhythm", "document")
    expect(screen.queryByTestId("code-block")).toBeNull()
  })

  it("toggles a Markdown attachment between rendered preview and existing source view", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      text: () => Promise.resolve("# Notes"),
    } as Response)
    render(<FilePartPreview url="blob:md" mediaType="text/markdown" filename="notes.md" />)
    await screen.findByTestId("markdown-preview")

    await userEvent.click(screen.getByRole("tab", { name: "source" }))
    expect(screen.getByTestId("code-block")).toHaveTextContent("# Notes")
    expect(screen.getByTestId("code-block")).toHaveAttribute("data-language", "markdown")

    await userEvent.click(screen.getByRole("tab", { name: "preview" }))
    expect(screen.getByTestId("markdown-preview")).toBeInTheDocument()
  })

  it("keeps CSV attachments in the existing code preview", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      text: () => Promise.resolve("name,value\nA,1"),
    } as Response)
    render(<FilePartPreview url="blob:csv" mediaType="text/csv" filename="table.csv" />)

    expect(await screen.findByTestId("code-block")).toHaveTextContent("name,value")
    expect(screen.queryByRole("tab")).toBeNull()
    expect(screen.queryByTestId("markdown-preview")).toBeNull()
  })
})
