import "fake-indexeddb/auto"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { SingleExportDialog } from "./single-export-dialog"
import type { ChatSession } from "@cognia/agent-config-types"

jest.mock("@/hooks/data/use-single-export", () => ({
  useSingleExport: () => ({ run: jest.fn(), busy: false }),
}))
jest.mock("@cognia/logging", () => ({
  ...jest.requireActual("@cognia/logging"),
  createLogger: () => ({ info: jest.fn(), error: jest.fn() }),
}))
jest.mock("@/stores/theme", () => ({
  useCustomThemeStore: () => undefined,
}))
// The custom-theme editor has its own suite; stub it so this test focuses on
// the export dialog's format/theme/PNG wiring.
jest.mock("./custom-theme-editor", () => ({ CustomThemeEditor: () => null }))
jest.mock("@/lib/db/schema", () => ({
  getDb: () => ({
    messages: { where: () => ({ equals: () => ({ sortBy: async () => [] }) }) },
  }),
}))
jest.mock("@/lib/twin/export-provenance", () => ({
  resolveSessionTwinProvenance: jest.fn(async () => undefined),
}))

const mockRenderChatToPng = jest.fn()
class FakeTooLong extends Error {}
jest.mock("@/lib/export/html/chat-png", () => ({
  renderChatToPng: (...a: unknown[]) => mockRenderChatToPng(...a),
  ChatPngTooLongError: FakeTooLong,
}))

const mockSaveExport = jest.fn()
jest.mock("@/lib/files/save-export", () => ({
  saveExport: (...a: unknown[]) => mockSaveExport(...a),
}))

const session = { id: "s1", title: "My chat" } as ChatSession

beforeEach(() => {
  jest.clearAllMocks()
  mockSaveExport.mockResolvedValue({
    kind: "saved",
    platform: "web",
    location: "downloads",
    filename: "my-chat.png",
  })
})

describe("SingleExportDialog", () => {
  it("renders the format picker and a share-via-link action", () => {
    render(<SingleExportDialog session={session} open onOpenChange={() => {}} />)
    expect(screen.getByText("Share via link")).toBeInTheDocument()
  })

  it("shows the theme gallery, wallpaper toggle and PNG action for HTML formats", () => {
    render(
      <SingleExportDialog session={session} defaultFormat="html" open onOpenChange={() => {}} />
    )
    expect(screen.getByTestId("theme-gallery")).toBeInTheDocument()
    // arknights (default) is a wallpaper theme.
    expect(screen.getByTestId("export-wallpaper")).toBeInTheDocument()
    expect(screen.getByTestId("export-download-png")).toBeInTheDocument()
  })

  it("does not offer a PNG for text formats", () => {
    render(
      <SingleExportDialog session={session} defaultFormat="markdown" open onOpenChange={() => {}} />
    )
    expect(screen.queryByTestId("export-download-png")).toBeNull()
    expect(screen.queryByTestId("theme-gallery")).toBeNull()
  })

  it("saves the rendered PNG through the cross-platform export boundary", async () => {
    const blob = new Blob(["png"], { type: "image/png" })
    mockRenderChatToPng.mockResolvedValue(blob)
    render(
      <SingleExportDialog session={session} defaultFormat="html" open onOpenChange={() => {}} />
    )
    fireEvent.click(screen.getByTestId("export-download-png"))
    await waitFor(() =>
      expect(mockSaveExport).toHaveBeenCalledWith({
        filename: "my-chat.png",
        data: blob,
        mimeType: "image/png",
      })
    )
  })

  it("surfaces the too-long message when the render overflows", async () => {
    mockRenderChatToPng.mockRejectedValue(new FakeTooLong())
    render(
      <SingleExportDialog session={session} defaultFormat="html" open onOpenChange={() => {}} />
    )
    fireEvent.click(screen.getByTestId("export-download-png"))
    await waitFor(() =>
      expect(
        screen.getByText(
          "This conversation is too long to render as one image — export HTML instead."
        )
      ).toBeInTheDocument()
    )
    expect(mockSaveExport).not.toHaveBeenCalled()
  })

  it("surfaces an error when the platform saver rejects the rendered PNG", async () => {
    mockRenderChatToPng.mockResolvedValue(new Blob(["png"], { type: "image/png" }))
    mockSaveExport.mockResolvedValueOnce({ kind: "error", message: "permission denied" })
    render(
      <SingleExportDialog session={session} defaultFormat="html" open onOpenChange={() => {}} />
    )

    fireEvent.click(screen.getByTestId("export-download-png"))

    await waitFor(() =>
      expect(screen.getByText("Failed to render the image. Try again.")).toBeInTheDocument()
    )
  })
})
