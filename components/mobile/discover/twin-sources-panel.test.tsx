/**
 * @jest-environment jsdom
 */
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { TwinSourcesPanel } from "./twin-sources-panel"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

// The panel lists sources over `twin_source_list` rather than from Dexie:
// `twinSources` is not a companion-sync table, so the local mirror it used to
// read is empty on every paired device.
let mockSources: Array<Record<string, unknown>> = []
const transportCallMock = jest.fn(async (command: string) =>
  command === "twin_source_list" ? { sources: mockSources } : {}
)
jest.mock("@/lib/tauri", () => ({
  transport: { call: (...a: unknown[]) => transportCallMock(...(a as [string])) },
}))
jest.mock("@/hooks/use-runtime-snapshot", () => ({
  useRuntimeSnapshot: () => ({ target: null, host: null }),
}))

const enqueueMock = jest.fn(async (..._a: unknown[]) => ({}))
jest.mock("@/lib/db/mobile-outbound-queue", () => ({ enqueue: (...a: unknown[]) => enqueueMock(...a) }))

const promptMock = jest.fn()
jest.mock("@/lib/capacitor/dialog", () => ({ prompt: (...a: unknown[]) => promptMock(...a) }))

const pickPhotoMock = jest.fn()
jest.mock("@/lib/capacitor/camera", () => ({ pickPhoto: (...a: unknown[]) => pickPhotoMock(...a) }))

let mockNoLeak = true
jest.mock("@cognia/redact", () => ({ hasNoLeakingPii: () => mockNoLeak }))


jest.mock("sonner", () => ({ toast: { success: jest.fn(), error: jest.fn(), info: jest.fn() } }))

// Stub the redact sheet so we can assert it opened with the pending text.
jest.mock("@/components/mobile/discover/redact-review-sheet", () => ({
  RedactReviewSheet: ({ open, text }: { open: boolean; text: string }) =>
    open ? <div data-testid="stub-redact-sheet" data-text={text} /> : null,
}))

// Stub LongPress → expose its onLongPress as a click.
jest.mock("@/components/interactions/long-press", () => ({
  LongPress: ({ children, onLongPress }: { children: React.ReactNode; onLongPress: () => void }) => (
    <div data-testid="stub-longpress" onClick={onLongPress}>
      {children}
    </div>
  ),
}))

beforeEach(() => {
  mockSources = []
  mockNoLeak = true
  enqueueMock.mockClear()
  promptMock.mockReset()
  pickPhotoMock.mockReset()
  transportCallMock.mockClear()
})

describe("<TwinSourcesPanel />", () => {
  it("enqueues clean pasted text directly (no redact sheet)", async () => {
    promptMock.mockResolvedValue({ kind: "submitted", value: "hello world" })
    const user = userEvent.setup()
    render(<TwinSourcesPanel twinId="twin-1" />)
    await user.click(screen.getByTestId("twin-sources-add"))
    await user.click(screen.getByTestId("twin-sources-paste"))
    await waitFor(() =>
      expect(enqueueMock).toHaveBeenCalledWith(
        expect.objectContaining({ command: "twin_source_create" })
      )
    )
    expect(screen.queryByTestId("stub-redact-sheet")).not.toBeInTheDocument()
  })

  it("routes pasted PII text through the redact-review sheet instead of enqueueing", async () => {
    mockNoLeak = false
    promptMock.mockResolvedValue({ kind: "submitted", value: "ssn 123-45-6789" })
    const user = userEvent.setup()
    render(<TwinSourcesPanel twinId="twin-1" />)
    await user.click(screen.getByTestId("twin-sources-add"))
    await user.click(screen.getByTestId("twin-sources-paste"))
    await waitFor(() => expect(screen.getByTestId("stub-redact-sheet")).toBeInTheDocument())
    expect(enqueueMock).not.toHaveBeenCalled()
  })

  it("enqueues a captured image (camera path)", async () => {
    pickPhotoMock.mockResolvedValue({ kind: "captured", base64: "BBBB", format: "png" })
    const user = userEvent.setup()
    render(<TwinSourcesPanel twinId="twin-1" />)
    await user.click(screen.getByTestId("twin-sources-add"))
    await user.click(screen.getByTestId("twin-sources-camera"))
    await waitFor(() =>
      expect(enqueueMock).toHaveBeenCalledWith(
        expect.objectContaining({
          command: "twin_source_create",
          payload: expect.objectContaining({ format: "image", base64: "BBBB" }),
        })
      )
    )
  })

  it("enqueues a picked file as base64", async () => {
    const user = userEvent.setup()
    render(<TwinSourcesPanel twinId="twin-1" />)
    await user.click(screen.getByTestId("twin-sources-add"))
    const input = screen.getByTestId("twin-sources-file-input") as HTMLInputElement
    const file = new File(["hello"], "notes.txt", { type: "text/plain" })
    // jsdom's File lacks arrayBuffer(); provide it for the base64 encode path.
    Object.defineProperty(file, "arrayBuffer", {
      value: async () => new TextEncoder().encode("hello").buffer,
    })
    await user.upload(input, file)
    await waitFor(() =>
      expect(enqueueMock).toHaveBeenCalledWith(
        expect.objectContaining({
          command: "twin_source_create",
          payload: expect.objectContaining({ filename: "notes.txt" }),
        })
      )
    )
  })

  it("renders the empty state when there are no sources", async () => {
    mockSources = []
    render(<TwinSourcesPanel twinId="twin-1" />)
    expect(await screen.findByText("empty")).toBeInTheDocument()
  })

  it("lists the sources the host reports rather than a local mirror", async () => {
    mockSources = [
      { id: "s9", title: "Handbook", status: "parsed", format: "pdf", bytes: 10, createdAt: 1 },
    ]
    render(<TwinSourcesPanel twinId="twin-7" />)
    expect(await screen.findByText("Handbook")).toBeInTheDocument()
    expect(transportCallMock).toHaveBeenCalledWith("twin_source_list", { twinId: "twin-7" })
  })

  it("long-pressing a source can retitle it", async () => {
    mockSources = [
      { id: "s2", title: "Old", status: "parsed", format: "pdf", bytes: 1024, createdAt: 1 },
    ]
    promptMock.mockResolvedValue({ kind: "submitted", value: "New title" })
    const user = userEvent.setup()
    render(<TwinSourcesPanel twinId="twin-1" />)
    await user.click(await screen.findByTestId("stub-longpress"))
    await user.click(await screen.findByTestId("twin-source-retitle"))
    // Queued for the host, not written into the local mirror. The old path
    // called `updateTwinSource` directly, so a rename on a paired phone was
    // gone again the next time the list refreshed.
    await waitFor(() =>
      expect(enqueueMock).toHaveBeenCalledWith(
        expect.objectContaining({
          command: "twin_source_update",
          payload: { id: "s2", patch: { title: "New title" } },
        })
      )
    )
  })

  it("long-pressing a source opens the editor and deletes it", async () => {
    mockSources = [
      { id: "s1", title: "Resume", status: "parsed", format: "pdf", bytes: 2048, createdAt: 1 },
    ]
    const user = userEvent.setup()
    render(<TwinSourcesPanel twinId="twin-1" />)
    await user.click(await screen.findByTestId("stub-longpress"))
    expect(await screen.findByTestId("twin-source-edit-sheet")).toBeInTheDocument()
    await user.click(screen.getByTestId("twin-source-delete"))
    await waitFor(() =>
      expect(enqueueMock).toHaveBeenCalledWith(
        expect.objectContaining({ command: "twin_source_delete", payload: { id: "s1" } })
      )
    )
  })
})
