/**
 * @jest-environment jsdom
 */
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { FilePartCard, FilePartPreview, filePreviewKind } from "./file-part-preview"

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
jest.mock("@/components/chat/renderers/video-block", () => ({
  VideoBlock: ({ src, title }: { src: string; title?: string }) => (
    <video data-testid="video-block" src={src} title={title} />
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

  it("plays a video in the shared player without fetching it", () => {
    render(<FilePartPreview url="blob:v" mediaType="video/mp4" filename="A paper boat.mp4" />)
    expect(screen.getByTestId("file-preview-video")).toBeInTheDocument()
    expect(screen.getByTestId("video-block")).toHaveAttribute("src", "blob:v")
    expect(screen.getByTestId("video-block")).toHaveAttribute("title", "A paper boat.mp4")
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("recognizes a video by its extension, and leaves unplayable containers to download", () => {
    const { unmount } = render(<FilePartPreview url="blob:v" filename="clip.MOV" />)
    expect(screen.getByTestId("video-block")).toBeInTheDocument()
    unmount()
    render(<FilePartPreview url="blob:v" mediaType="video/x-msvideo" filename="old.avi" />)
    expect(screen.queryByTestId("video-block")).toBeNull()
    expect(screen.getByTestId("file-download-link")).toHaveTextContent("old.avi")
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

  it("renders HTML attachments live in the artifact sandbox frame", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      text: () => Promise.resolve("<h1>Hello</h1><script>alert(1)</script>"),
    } as Response)
    render(<FilePartPreview url="blob:html" mediaType="text/html" filename="page.html" />)

    const frame = (await screen.findByTestId("file-preview-html-frame")) as HTMLIFrameElement
    // Same policy as the static artifact preview: same-origin so the parent
    // can write contentDocument, and the sanitize inside renderHTML strips
    // scripts before they ever reach the frame.
    expect(frame).toHaveAttribute("sandbox", "allow-same-origin")
    await waitFor(() => expect(frame.contentDocument?.body.innerHTML).toContain("Hello"))
    expect(frame.contentDocument?.body.innerHTML).not.toContain("script")

    await userEvent.click(screen.getByRole("tab", { name: "source" }))
    expect(screen.getByTestId("code-block")).toHaveTextContent("<h1>Hello</h1>")
    expect(screen.getByTestId("code-block")).toHaveAttribute("data-language", "html")
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

describe("filePreviewKind", () => {
  it.each([
    ["application/pdf", "a.pdf", "pdf"],
    ["video/mp4", "clip.mp4", "video"],
    ["text/html", "page.html", "html"],
    ["text/markdown", "notes.md", "markdown"],
    ["text/x-python", "main.py", "text"],
    ["application/zip", "bundle.zip", "file"],
  ] as const)("reads %s (%s) as %s", (mediaType, filename, kind) => {
    expect(filePreviewKind(mediaType, filename)).toBe(kind)
  })
})

describe("FilePartCard", () => {
  it("heads a previewable file with the file card, its kind and a download action", async () => {
    fetchMock.mockResolvedValue({ ok: true, text: async () => "print(1)" })
    render(<FilePartCard url="blob:py" mediaType="text/x-python" filename="main.py" />)
    const card = screen.getByTestId("file-part-card")
    expect(card).toHaveTextContent("main.py")
    expect(card).toHaveTextContent("kind.text")
    expect(screen.getByTestId("file-part-card-download")).toHaveAttribute("href", "blob:py")
    expect(await screen.findByTestId("code-block")).toHaveTextContent("print(1)")
  })

  it("collapses and reopens the preview from its header", async () => {
    fetchMock.mockResolvedValue({ ok: true, text: async () => "body" })
    render(<FilePartCard url="blob:md" mediaType="text/plain" filename="a.txt" />)
    const toggle = screen.getByRole("button", { name: /toggle/ })
    expect(toggle).toHaveAttribute("aria-expanded", "true")
    await userEvent.click(toggle)
    expect(toggle).toHaveAttribute("aria-expanded", "false")
    expect(screen.queryByTestId("file-part-card-body")).toBeNull()
    await userEvent.click(toggle)
    expect(screen.getByTestId("file-part-card-body")).toBeInTheDocument()
  })

  it("starts closed when asked", () => {
    render(
      <FilePartCard
        url="blob:pdf"
        mediaType="application/pdf"
        filename="a.pdf"
        defaultExpanded={false}
      />
    )
    expect(screen.queryByTestId("file-part-card-body")).toBeNull()
  })

  it("names the file once: no second download card inside a failed preview", async () => {
    fetchMock.mockRejectedValue(new Error("gone"))
    render(<FilePartCard url="blob:x" mediaType="text/plain" filename="a.txt" />)
    expect(await screen.findByTestId("file-preview-unavailable")).toBeInTheDocument()
    expect(screen.queryByTestId("file-download-link")).toBeNull()
  })

  it("is the download card alone for a file with no inline preview", () => {
    render(<FilePartCard url="blob:zip" mediaType="application/zip" filename="bundle.zip" />)
    const link = screen.getByTestId("file-download-link")
    expect(link).toHaveAttribute("href", "blob:zip")
    expect(link).toHaveTextContent("bundle.zip")
    expect(screen.queryByTestId("file-part-card")).toBeNull()
  })
})
