/**
 * @jest-environment jsdom
 */
import { render, screen, waitFor } from "@testing-library/react"
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
})
