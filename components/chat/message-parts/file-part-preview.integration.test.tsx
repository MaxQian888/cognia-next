import { render, screen } from "@testing-library/react"
import { registerFileViewer } from "@/lib/file-viewer/registry"
import { FilePartPreview } from "./file-part-preview"

jest.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))
jest.mock(
  "next/dynamic",
  () => () =>
    function RegisteredViewer({ text }: { text: string }) {
      return <pre>{text}</pre>
    }
)
jest.mock("@/components/chat/markdown-renderer", () => ({ MarkdownRenderer: () => null }))
jest.mock("@/components/chat/renderers/code-block", () => ({ CodeBlock: () => null }))
jest.mock("@/components/chat/renderers/video-block", () => ({ VideoBlock: () => null }))

it("carries MIME and original text from an attachment through the real shared viewer surface", async () => {
  const originalFetch = global.fetch
  const dispose = registerFileViewer({
    id: "test.attachment-mime-integration",
    priority: 200,
    matches: (probe) =>
      probe.source === "attachment" && probe.mimeType === "application/x-preview-test",
    load: async () => ({ default: () => null }),
  })
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    text: async () => "Original attachment body",
  }) as unknown as typeof fetch
  const view = render(
    <FilePartPreview
      url="blob:mime-integration"
      filename="custom.bin"
      mediaType="application/x-preview-test"
    />
  )
  try {
    expect(await screen.findByText("Original attachment body")).toBeInTheDocument()
    expect(screen.getByTestId("file-preview-surface")).toHaveAttribute(
      "data-viewer-id",
      "test.attachment-mime-integration"
    )
    expect(screen.getByTestId("file-preview-surface")).toHaveAttribute("data-source", "attachment")
    expect(screen.queryByTestId("file-download-link")).not.toBeInTheDocument()
  } finally {
    view.unmount()
    dispose()
    global.fetch = originalFetch
  }
})
