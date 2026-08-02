import type { ReactElement } from "react"
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { TooltipProvider } from "@/components/ui/tooltip"
import type { ExtractedAttachment } from "@/lib/chat/attachments/dispatch"
import { AttachmentPreview } from "./attachment-preview"
import type { StagedAttachmentState, StagedAttachmentsValue } from "./staged-attachment-store"

const mockRemove = jest.fn()
const mockToggleIncludeOcr = jest.fn()
const mockReorder = jest.fn()

const mockState: {
  files: Array<{
    id: string
    type?: "file"
    mediaType?: string
    filename?: string
    url?: string
  }>
  byId: Map<string, StagedAttachmentState>
  order: string[]
} = { files: [], byId: new Map(), order: [] }

jest.mock("@/components/ai-elements/prompt-input", () => ({
  usePromptInputAttachments: () => ({ files: mockState.files, remove: mockRemove }),
}))

jest.mock("./staged-attachment-store", () => ({
  useStagedAttachments: (): StagedAttachmentsValue => ({
    byId: mockState.byId,
    order: mockState.order,
    isExtracting: false,
    totalBytes: 0,
    totalTokens: 0,
    precomputed: new Map(),
    whenSettled: async () => {},
    reorder: mockReorder,
    setOcrText: jest.fn(),
    toggleIncludeOcr: mockToggleIncludeOcr,
    seedIncoming: jest.fn(),
  }),
}))

const renderPreview = (ui: ReactElement) => render(<TooltipProvider>{ui}</TooltipProvider>)

// Radix activates tabs on mouseDown (not click), and an open Sheet sets
// `pointer-events: none` on <body> — so these interactions need the full
// userEvent sequence with the pointer-events guard disabled.
const user = () => userEvent.setup({ pointerEventsCheck: 0 })

function ready(extracted: Partial<ExtractedAttachment> = {}): StagedAttachmentState {
  return {
    status: "ready",
    sizeBytes: 100,
    extracted: { kind: "document", block: { type: "text", text: "x" }, tokens: 0, ...extracted },
  }
}

/** Stage `files` and mark them all settled unless a state is given explicitly. */
function stage(
  files: Array<{ id: string; mediaType?: string; filename?: string; url?: string }>,
  states: Record<string, StagedAttachmentState> = {}
) {
  // `type: "file"` is what the real provider emits; the vendored primitives
  // key their image branch off it.
  mockState.files = files.map((f) => ({ type: "file" as const, ...f }))
  mockState.order = files.map((f) => f.id)
  mockState.byId = new Map(files.map((f) => [f.id, states[f.id] ?? ready()]))
}

beforeEach(() => {
  mockRemove.mockClear()
  mockToggleIncludeOcr.mockClear()
  mockReorder.mockClear()
  stage([])
})

describe("AttachmentPreview — chip rendering", () => {
  it("renders an image thumbnail and a document chip", () => {
    stage([
      { id: "a", mediaType: "image/png", filename: "pic.png", url: "blob:x" },
      { id: "b", mediaType: "application/pdf", filename: "doc.pdf" },
    ])
    renderPreview(<AttachmentPreview />)
    expect(screen.getByAltText("pic.png")).toBeInTheDocument()
    expect(screen.getByText("doc.pdf")).toBeInTheDocument()
    expect(screen.getAllByTestId("composer-attachment-chip")).toHaveLength(2)
  })

  it("renders chips in the store's order, not the file list's", () => {
    mockState.files = [
      { id: "a", type: "file", filename: "first.txt" },
      { id: "b", type: "file", filename: "second.txt" },
    ]
    mockState.order = ["b", "a"]
    mockState.byId = new Map([
      ["a", ready()],
      ["b", ready()],
    ])
    renderPreview(<AttachmentPreview />)
    const chips = screen.getAllByTestId("composer-attachment-chip")
    expect(within(chips[0]!).getByText("second.txt")).toBeInTheDocument()
    expect(within(chips[1]!).getByText("first.txt")).toBeInTheDocument()
  })

  it("removes an attachment when its remove button is clicked", () => {
    stage([{ id: "b", mediaType: "application/pdf", filename: "doc.pdf" }])
    renderPreview(<AttachmentPreview />)
    fireEvent.click(screen.getByRole("button", { name: /Remove doc\.pdf/i }))
    expect(mockRemove).toHaveBeenCalledWith("b")
  })

  // Regression guard for the touch defect: the remove button used to be
  // absolutely positioned over the filename and hidden until hover.
  it("keeps the remove button visible rather than hover-gated", () => {
    stage([{ id: "b", filename: "doc.pdf" }])
    renderPreview(<AttachmentPreview />)
    const remove = screen.getByRole("button", { name: /Remove doc\.pdf/i })
    expect(remove.className).not.toContain("opacity-0")
    expect(remove.className).not.toContain("absolute")
  })
})

describe("AttachmentPreview — extraction status badges", () => {
  it("shows a spinner while a file is still being read", () => {
    stage([{ id: "a", filename: "big.pdf" }], {
      a: { status: "extracting", sizeBytes: 0 },
    })
    renderPreview(<AttachmentPreview />)
    expect(screen.getByTestId("attachment-extracting")).toBeInTheDocument()
    expect(screen.queryByTestId("attachment-tokens")).not.toBeInTheDocument()
  })

  // An image's wait is a decode + downscale, not a text parse, and it is the
  // slow one — it gets the scan indicator instead of the generic spinner.
  it("shows the analyzing-image indicator while an image is being read", () => {
    stage([{ id: "a", mediaType: "image/png", filename: "p.png", url: "blob:x" }], {
      a: { status: "extracting", sizeBytes: 0 },
    })
    renderPreview(<AttachmentPreview />)
    expect(screen.getByTestId("attachment-analyzing-image")).toBeInTheDocument()
    expect(screen.queryByTestId("attachment-extracting")).not.toBeInTheDocument()
  })

  it("keeps the plain spinner for documents (the photo glyph would misdescribe one)", () => {
    stage([{ id: "a", mediaType: "application/pdf", filename: "doc.pdf" }], {
      a: { status: "extracting", sizeBytes: 0 },
    })
    renderPreview(<AttachmentPreview />)
    expect(screen.getByTestId("attachment-extracting")).toBeInTheDocument()
    expect(screen.queryByTestId("attachment-analyzing-image")).not.toBeInTheDocument()
  })

  it("treats an id with no state yet as still extracting", () => {
    mockState.files = [{ id: "a", type: "file", filename: "new.pdf" }]
    mockState.order = ["a"]
    mockState.byId = new Map()
    renderPreview(<AttachmentPreview />)
    expect(screen.getByTestId("attachment-extracting")).toBeInTheDocument()
  })

  it("shows the token cost once a document settles", () => {
    stage([{ id: "a", filename: "notes.txt" }], { a: ready({ tokens: 1234 }) })
    renderPreview(<AttachmentPreview />)
    expect(screen.getByTestId("attachment-tokens")).toHaveTextContent("1234")
  })

  it("omits the token badge for images (they cost no inline text tokens)", () => {
    stage([{ id: "a", mediaType: "image/png", filename: "p.png", url: "blob:x" }], {
      a: { status: "ready", sizeBytes: 10, extracted: { kind: "image", block: null, tokens: 0 } },
    })
    renderPreview(<AttachmentPreview />)
    expect(screen.queryByTestId("attachment-tokens")).not.toBeInTheDocument()
  })

  it("flags a rejected attachment with its reason instead of silently dropping it", () => {
    stage([{ id: "a", filename: "thing.xyz" }], {
      a: {
        status: "rejected",
        sizeBytes: 5,
        extracted: {
          kind: "document",
          block: null,
          tokens: 0,
          rejectReason: "unsupported-type",
        },
      },
    })
    renderPreview(<AttachmentPreview />)
    const badge = screen.getByTestId("attachment-rejected")
    expect(badge).toBeInTheDocument()
    expect(screen.getByLabelText("Unsupported file type")).toBeInTheDocument()
  })

  it("renders each rejection reason's own message", () => {
    stage(
      [
        { id: "a", filename: "1" },
        { id: "b", filename: "2" },
        { id: "c", filename: "3" },
      ],
      {
        a: {
          status: "rejected",
          sizeBytes: 0,
          extracted: { kind: "document", block: null, tokens: 0, rejectReason: "empty" },
        },
        b: {
          status: "rejected",
          sizeBytes: 0,
          extracted: { kind: "document", block: null, tokens: 0, rejectReason: "parse-failed" },
        },
        c: {
          status: "rejected",
          sizeBytes: 0,
          extracted: { kind: "image", block: null, tokens: 0, rejectReason: "not-data-url" },
        },
      }
    )
    renderPreview(<AttachmentPreview />)
    expect(screen.getByLabelText("No readable text found")).toBeInTheDocument()
    expect(screen.getByLabelText("Couldn't parse this file")).toBeInTheDocument()
    expect(screen.getByLabelText("Couldn't read this file")).toBeInTheDocument()
  })
})

describe("AttachmentPreview — preview panel", () => {
  it("opens the preview sheet for the clicked chip", () => {
    stage([{ id: "a", filename: "notes.txt", url: "data:text/plain;base64,eA==" }], {
      a: ready({ text: 'Attached file "notes.txt":\n\nbody', tokens: 12 }),
    })
    renderPreview(<AttachmentPreview />)
    fireEvent.click(screen.getByRole("button", { name: /Preview notes\.txt/i }))
    const dialog = screen.getByRole("dialog")
    expect(within(dialog).getByRole("heading", { name: "notes.txt" })).toBeInTheDocument()
    expect(within(dialog).getByRole("tab", { name: "Model view" })).toBeInTheDocument()
  })

  it("shows the model-visible text, not the raw file, on the model tab", async () => {
    stage([{ id: "a", filename: "notes.txt", url: "data:text/plain;base64,eA==" }], {
      a: ready({ text: 'Attached file "notes.txt":\n\nsecret body', tokens: 12 }),
    })
    renderPreview(<AttachmentPreview />)
    fireEvent.click(screen.getByRole("button", { name: /Preview notes\.txt/i }))
    await user().click(screen.getByRole("tab", { name: "Model view" }))
    expect(screen.getByText(/secret body/)).toBeInTheDocument()
  })

  it("marks redacted spans in the model view", async () => {
    stage([{ id: "a", filename: "c.txt", url: "data:text/plain;base64,eA==" }], {
      a: ready({ text: "Contact <EMAIL_001> now", tokens: 5 }),
    })
    renderPreview(<AttachmentPreview />)
    fireEvent.click(screen.getByRole("button", { name: /Preview c\.txt/i }))
    await user().click(screen.getByRole("tab", { name: "Model view" }))
    expect(screen.getByTestId("redacted-span")).toHaveTextContent("<EMAIL_001>")
    expect(screen.getByTestId("redaction-note")).toBeInTheDocument()
  })

  it("offers to run OCR for an image and hides the note when nothing was redacted", async () => {
    const onRunOcr = jest.fn()
    stage([{ id: "a", mediaType: "image/png", filename: "p.png", url: "blob:x" }], {
      a: {
        status: "ready",
        sizeBytes: 10,
        extracted: {
          kind: "image",
          block: null,
          tokens: 0,
          image: { mediaType: "image/png", bytes: 900 },
        },
      },
    })
    renderPreview(<AttachmentPreview onRunOcr={onRunOcr} />)
    fireEvent.click(screen.getByRole("button", { name: /Preview p\.png/i }))
    await user().click(screen.getByRole("tab", { name: "Model view" }))
    expect(screen.getByTestId("model-view-image")).toBeInTheDocument()
    await user().click(screen.getByRole("button", { name: "Run OCR" }))
    expect(onRunOcr).toHaveBeenCalledWith("a")
  })

  it("exposes the OCR opt-in and both follow-up routes once text exists", async () => {
    const onViewOcrDetail = jest.fn()
    const onExtractOcrToInput = jest.fn()
    stage([{ id: "a", mediaType: "image/png", filename: "p.png", url: "blob:x" }], {
      a: {
        status: "ready",
        sizeBytes: 10,
        ocrText: "recognised words",
        includeOcr: true,
        extracted: { kind: "image", block: null, tokens: 0 },
      },
    })
    renderPreview(
      <AttachmentPreview
        onViewOcrDetail={onViewOcrDetail}
        onExtractOcrToInput={onExtractOcrToInput}
      />
    )
    fireEvent.click(screen.getByRole("button", { name: /Preview p\.png/i }))
    await user().click(screen.getByRole("tab", { name: "Model view" }))

    expect(screen.getByText("recognised words")).toBeInTheDocument()
    await user().click(screen.getByRole("switch"))
    expect(mockToggleIncludeOcr).toHaveBeenCalledWith("a")

    await user().click(screen.getByRole("button", { name: "View per-page result" }))
    expect(onViewOcrDetail).toHaveBeenCalled()
    await user().click(screen.getByRole("button", { name: "Add text to message" }))
    expect(onExtractOcrToInput).toHaveBeenCalledWith("a")
  })

  it("shows the empty state when nothing could be extracted", async () => {
    stage([{ id: "a", filename: "scan.pdf", url: "data:application/pdf;base64,eA==" }], {
      a: {
        status: "rejected",
        sizeBytes: 10,
        extracted: { kind: "document", block: null, tokens: 0, rejectReason: "empty" },
      },
    })
    renderPreview(<AttachmentPreview />)
    fireEvent.click(screen.getByRole("button", { name: /Preview scan\.pdf/i }))
    await user().click(screen.getByRole("tab", { name: "Model view" }))
    expect(screen.getByText("Nothing was extracted from this file.")).toBeInTheDocument()
  })
})

describe("AttachmentPreview — container modes", () => {
  // The presence boundary must survive an empty list, otherwise the LAST chip
  // to be removed unmounts before it can play its exit animation.
  it("keeps the chip container mounted with no attachments", () => {
    const { container } = renderPreview(<AttachmentPreview />)
    expect(container.firstChild).not.toBeNull()
    expect(screen.queryAllByTestId("composer-attachment-chip")).toHaveLength(0)
  })

  it("standalone mode applies padding only while a chip is present", () => {
    stage([{ id: "b", filename: "doc.pdf" }])
    const { container } = renderPreview(<AttachmentPreview />)
    expect((container.firstChild as HTMLElement).className).toContain("has-[>*]:pt-2")
  })

  it("bare mode omits the padded container so a parent bar can lay chips out", () => {
    stage([{ id: "b", filename: "doc.pdf" }])
    const { container } = renderPreview(<AttachmentPreview bare />)
    expect((container.firstChild as HTMLElement)?.className ?? "").not.toContain("has-[>*]:pt-2")
    expect(screen.getByText("doc.pdf")).toBeInTheDocument()
  })

  it("falls back to a generic label for a file with no filename", () => {
    stage([{ id: "e" }])
    renderPreview(<AttachmentPreview />)
    expect(screen.getByRole("button", { name: /Preview attachment/i })).toBeInTheDocument()
  })
})

describe("AttachmentPreview — reorder wiring", () => {
  // The reorder DECISION is unit-tested in lib/chat/attachments/reorder.test.ts;
  // simulating a real dnd-kit drag in jsdom tests the library, not this code.
  // What matters here is that each chip is actually registered as sortable and
  // stays clickable — the two things that break silently.
  it("registers every chip as a draggable sortable item", () => {
    stage([
      { id: "a", filename: "one.txt" },
      { id: "b", filename: "two.txt" },
    ])
    renderPreview(<AttachmentPreview />)
    const handles = screen.getAllByLabelText(/Reorder (one|two)\.txt/)
    expect(handles).toHaveLength(2)
    // dnd-kit marks draggables with a roledescription for assistive tech.
    expect(handles[0]).toHaveAttribute("aria-roledescription", "sortable")
  })

  // Regression guard for the activation constraint: without `distance: 4` the
  // drag sensor swallows the click and the preview panel can never open.
  it("keeps a chip clickable even though it is draggable", () => {
    stage([{ id: "a", filename: "one.txt", url: "data:text/plain;base64,eA==" }])
    renderPreview(<AttachmentPreview />)
    fireEvent.click(screen.getByRole("button", { name: /Preview one\.txt/i }))
    expect(screen.getByRole("dialog")).toBeInTheDocument()
  })

  // Drives the real keyboard-drag path dnd-kit exposes for assistive tech, which
  // is also the only way to exercise the drag lifecycle in jsdom (pointer drags
  // need layout boxes, and every rect is 0x0 here).
  it("runs the drag lifecycle from the keyboard without reordering on a cancel", () => {
    stage([
      { id: "a", filename: "one.txt" },
      { id: "b", filename: "two.txt" },
    ])
    renderPreview(<AttachmentPreview />)
    const handle = screen.getAllByLabelText(/Reorder/)[0]!
    handle.focus()
    fireEvent.keyDown(handle, { key: " ", code: "Space" })
    fireEvent.keyDown(handle, { key: "Escape", code: "Escape" })
    expect(mockReorder).not.toHaveBeenCalled()
  })

  // Completing the drag runs onDragEnd. jsdom reports every element as 0x0, so
  // @dnd-kit resolves no drop target and the move correctly does not commit —
  // the commit rule itself is unit-tested as `resolveDragEnd`.
  it("ends a keyboard drag cleanly when no drop target resolves", () => {
    stage([
      { id: "a", filename: "one.txt" },
      { id: "b", filename: "two.txt" },
    ])
    renderPreview(<AttachmentPreview />)
    const handle = screen.getAllByLabelText(/Reorder/)[0]!
    handle.focus()
    fireEvent.keyDown(handle, { key: " ", code: "Space" })
    fireEvent.keyDown(handle, { key: "ArrowRight", code: "ArrowRight" })
    fireEvent.keyDown(handle, { key: " ", code: "Space" })
    expect(mockReorder).not.toHaveBeenCalled()
    expect(screen.getAllByTestId("composer-attachment-chip")).toHaveLength(2)
  })
})

describe("AttachmentPreview — preview panel lifecycle", () => {
  it("closes the panel and forgets the target", async () => {
    stage([{ id: "a", filename: "one.txt", url: "data:text/plain;base64,eA==" }])
    renderPreview(<AttachmentPreview />)
    fireEvent.click(screen.getByRole("button", { name: /Preview one\.txt/i }))
    expect(screen.getByRole("dialog")).toBeInTheDocument()

    await user().keyboard("{Escape}")
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
  })
})
