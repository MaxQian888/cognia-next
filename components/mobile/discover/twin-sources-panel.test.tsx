/**
 * @jest-environment jsdom
 */
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { TwinSourcesPanel } from "./twin-sources-panel"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

let mockSources: Array<Record<string, unknown>> = []
jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: () => mockSources,
}))

jest.mock("@/lib/db/schema", () => ({
  getDb: () => ({ twinSources: { orderBy: () => ({ reverse: () => ({ toArray: async () => [] }) }) } }),
}))

const enqueueMock = jest.fn(async (..._a: unknown[]) => ({}))
jest.mock("@/lib/db/mobile-outbound-queue", () => ({ enqueue: (...a: unknown[]) => enqueueMock(...a) }))

const promptMock = jest.fn()
jest.mock("@/lib/capacitor/dialog", () => ({ prompt: (...a: unknown[]) => promptMock(...a) }))

const pickPhotoMock = jest.fn()
jest.mock("@/lib/capacitor/camera", () => ({ pickPhoto: (...a: unknown[]) => pickPhotoMock(...a) }))

let mockNoLeak = true
jest.mock("@/lib/twin/ingest/redact", () => ({ hasNoLeakingPii: () => mockNoLeak }))

const updateTwinSourceMock = jest.fn(async (..._a: unknown[]) => undefined)
const deleteTwinSourceMock = jest.fn(async (..._a: unknown[]) => undefined)
jest.mock("@/lib/db/twin-sources", () => ({
  updateTwinSource: (...a: unknown[]) => updateTwinSourceMock(...a),
  deleteTwinSource: (...a: unknown[]) => deleteTwinSourceMock(...a),
}))

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
  updateTwinSourceMock.mockClear()
  deleteTwinSourceMock.mockClear()
})

describe("<TwinSourcesPanel />", () => {
  it("enqueues clean pasted text directly (no redact sheet)", async () => {
    promptMock.mockResolvedValue({ kind: "submitted", value: "hello world" })
    const user = userEvent.setup()
    render(<TwinSourcesPanel />)
    await user.click(screen.getByTestId("twin-sources-add"))
    await user.click(screen.getByTestId("twin-sources-paste"))
    await waitFor(() =>
      expect(enqueueMock).toHaveBeenCalledWith(
        expect.objectContaining({ command: "twin_ingest_source" })
      )
    )
    expect(screen.queryByTestId("stub-redact-sheet")).not.toBeInTheDocument()
  })

  it("routes pasted PII text through the redact-review sheet instead of enqueueing", async () => {
    mockNoLeak = false
    promptMock.mockResolvedValue({ kind: "submitted", value: "ssn 123-45-6789" })
    const user = userEvent.setup()
    render(<TwinSourcesPanel />)
    await user.click(screen.getByTestId("twin-sources-add"))
    await user.click(screen.getByTestId("twin-sources-paste"))
    await waitFor(() => expect(screen.getByTestId("stub-redact-sheet")).toBeInTheDocument())
    expect(enqueueMock).not.toHaveBeenCalled()
  })

  it("enqueues a captured image (camera path)", async () => {
    pickPhotoMock.mockResolvedValue({ kind: "captured", base64: "BBBB", format: "png" })
    const user = userEvent.setup()
    render(<TwinSourcesPanel />)
    await user.click(screen.getByTestId("twin-sources-add"))
    await user.click(screen.getByTestId("twin-sources-camera"))
    await waitFor(() =>
      expect(enqueueMock).toHaveBeenCalledWith(
        expect.objectContaining({
          command: "twin_ingest_source",
          payload: expect.objectContaining({ format: "image", base64: "BBBB" }),
        })
      )
    )
  })

  it("enqueues a picked file as base64", async () => {
    const user = userEvent.setup()
    render(<TwinSourcesPanel />)
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
          command: "twin_ingest_source",
          payload: expect.objectContaining({ filename: "notes.txt" }),
        })
      )
    )
  })

  it("renders the empty state when there are no sources", () => {
    mockSources = []
    render(<TwinSourcesPanel />)
    expect(screen.getByText("empty")).toBeInTheDocument()
  })

  it("long-pressing a source can retitle it", async () => {
    mockSources = [
      { id: "s2", title: "Old", status: "parsed", format: "pdf", bytes: 1024, createdAt: 1 },
    ]
    promptMock.mockResolvedValue({ kind: "submitted", value: "New title" })
    const user = userEvent.setup()
    render(<TwinSourcesPanel />)
    await user.click(screen.getByTestId("stub-longpress"))
    await user.click(await screen.findByTestId("twin-source-retitle"))
    await waitFor(() =>
      expect(updateTwinSourceMock).toHaveBeenCalledWith("s2", { title: "New title" })
    )
  })

  it("long-pressing a source opens the editor and deletes it", async () => {
    mockSources = [
      { id: "s1", title: "Resume", status: "parsed", format: "pdf", bytes: 2048, createdAt: 1 },
    ]
    const user = userEvent.setup()
    render(<TwinSourcesPanel />)
    await user.click(screen.getByTestId("stub-longpress"))
    expect(await screen.findByTestId("twin-source-edit-sheet")).toBeInTheDocument()
    await user.click(screen.getByTestId("twin-source-delete"))
    await waitFor(() => expect(deleteTwinSourceMock).toHaveBeenCalledWith("s1"))
  })
})
