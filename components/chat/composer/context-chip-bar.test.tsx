import { render, screen } from "@testing-library/react"
import { TooltipProvider } from "@/components/ui/tooltip"
import { ContextChipBar } from "./context-chip-bar"
import type { StagedAttachmentState, StagedAttachmentsValue } from "./staged-attachment-store"
import { useChatStore } from "@/stores/chat"
import { parseSegments } from "@/lib/slash-commands/parse-segments"

// Drive the attachment side through controllable mocks; the reference side
// reads the real chat-store.
const mockState: {
  files: Array<{ id: string; type?: "file"; mediaType?: string; filename?: string; url?: string }>
  byId: Map<string, StagedAttachmentState>
  order: string[]
  totalBytes: number
} = { files: [], byId: new Map(), order: [], totalBytes: 0 }

jest.mock("@/components/ai-elements/prompt-input", () => ({
  usePromptInputAttachments: () => ({ files: mockState.files, remove: jest.fn() }),
}))

jest.mock("./staged-attachment-store", () => ({
  useStagedAttachments: (): StagedAttachmentsValue => ({
    byId: mockState.byId,
    order: mockState.order,
    isExtracting: false,
    totalBytes: mockState.totalBytes,
    totalTokens: 0,
    precomputed: new Map(),
    whenSettled: async () => {},
    reorder: jest.fn(),
    setOcrText: jest.fn(),
    toggleIncludeOcr: jest.fn(),
    seedIncoming: jest.fn(),
  }),
}))

const renderBar = () =>
  render(
    <TooltipProvider>
      <ContextChipBar />
    </TooltipProvider>
  )

function stage(files: typeof mockState.files, totalBytes = 0) {
  mockState.files = files.map((f) => ({ type: "file" as const, ...f }))
  mockState.order = files.map((f) => f.id)
  mockState.byId = new Map(
    files.map((f) => [
      f.id,
      {
        status: "ready" as const,
        sizeBytes: 0,
        extracted: {
          kind: "document" as const,
          block: { type: "text" as const, text: "x" },
          tokens: 0,
        },
      },
    ])
  )
  mockState.totalBytes = totalBytes
}

beforeEach(() => {
  useChatStore.getState().clear()
  stage([])
})

describe("ContextChipBar", () => {
  // The bar used to early-return null when empty. That made the whole row pop
  // in and out while its sibling bands slid, AND tore down the chips'
  // <AnimatePresence> boundary so the last removed chip skipped its exit
  // animation. It now stays mounted and collapses its height instead.
  it("stays mounted with no references and no attachments", () => {
    const { container } = renderBar()
    expect(container.firstChild).not.toBeNull()
    expect(screen.queryAllByTestId("composer-attachment-chip")).toHaveLength(0)
  })

  it("keeps the padding off an empty row so it can collapse to zero height", () => {
    renderBar()
    const group = screen.getByRole("group", { name: /attached files, links, and references/i })
    // Padding is conditional on having at least one child element.
    expect(group.className).toContain("has-[>*]:pt-2")
    expect(group.className).not.toMatch(/(^|\s)pt-2(\s|$)/)
  })

  it("merges references and attachments into one labelled group", () => {
    useChatStore.getState().addReferencedPath({
      absolute: "/repo/src/index.ts",
      relative: "src/index.ts",
      isDir: false,
    })
    stage([{ id: "b", mediaType: "application/pdf", filename: "doc.pdf" }])
    renderBar()

    const group = screen.getByRole("group", { name: /attached files, links, and references/i })
    expect(group).toBeInTheDocument()
    expect(screen.getByText("src/index.ts")).toBeInTheDocument()
    expect(screen.getByText("doc.pdf")).toBeInTheDocument()
  })

  // The old implementation summed `estimateDataUrlBytes(f.url)`, which only
  // understands `data:` URLs — staged files carry `blob:` URLs, so the hint was
  // permanently 0 and never rendered at all. It now reads real staged sizes.
  it("shows the size hint for blob-backed attachments", () => {
    stage([{ id: "a", mediaType: "image/png", filename: "p.png", url: "blob:x" }], 5)
    renderBar()
    expect(screen.getByText("5B")).toBeInTheDocument()
  })

  it("omits the size hint when nothing is staged", () => {
    stage([], 0)
    renderBar()
    expect(screen.queryByText(/^\d+(\.\d+)?[KMG]?B$/)).toBeNull()
  })

  // Before this, the only feedback while a dropped photo was being decoded and
  // downscaled was the send button turning into a spinner — the bar itself
  // showed nothing, so a slow prepare looked like a dropped file.
  it("holds a placeholder for images that are still being prepared", () => {
    render(
      <TooltipProvider>
        <ContextChipBar preparingImageCount={2} />
      </TooltipProvider>
    )
    expect(screen.getByTestId("composer-preparing-images")).toBeInTheDocument()
    expect(screen.getByTestId("composer-preparing-images-label")).toHaveTextContent(
      "Preparing 2 images…"
    )
  })

  it("shows no placeholder once preparation settles", () => {
    renderBar()
    expect(screen.queryByTestId("composer-preparing-images")).not.toBeInTheDocument()
  })

  // Links used to be chipped here as well. They are not any more: a link is
  // visible in the text itself, as a blue underlined label, so a second copy
  // above the box was pure duplication — see the header of this component.
  it("does not chip a link that the text already shows", () => {
    render(
      <TooltipProvider>
        <ContextChipBar />
      </TooltipProvider>
    )
    expect(screen.queryByTestId("composer-link-chip")).toBeNull()
  })
})

describe("ContextChipBar — only what the text cannot show", () => {
  const KNOWN = new Set(["clear", "compact"])
  const parse = (input: string) => parseSegments(input, (name) => KNOWN.has(name))

  it("chips a FAILED command inside the same context group", () => {
    render(
      <TooltipProvider>
        <ContextChipBar
          segments={parse("/compact /clear")}
          commandErrors={[{ name: "clear", message: "boom" }]}
          onRemoveCommand={jest.fn()}
        />
      </TooltipProvider>
    )
    const group = screen.getByRole("group", { name: /attached files, links, and references/i })
    expect(group).toContainElement(screen.getByTestId("failed-command-pill-clear"))
  })

  it("keeps staged commands out of the row — each is a pill on its own token", () => {
    render(
      <TooltipProvider>
        <ContextChipBar segments={parse("/compact /clear")} onRemoveCommand={jest.fn()} />
      </TooltipProvider>
    )
    expect(screen.queryByTestId("failed-command-pill-clear")).toBeNull()
  })

  // jsdom lays nothing out, so every child reports offsetTop 0 and the fold
  // stays disengaged. That is the honest answer for an unlaid-out row; the
  // arithmetic itself is covered in `use-overflow-fold.test.ts`.
  it("shows no fold toggle when nothing overflows", () => {
    render(
      <TooltipProvider>
        <ContextChipBar segments={parse("/compact /clear")} onRemoveCommand={jest.fn()} />
      </TooltipProvider>
    )
    expect(screen.queryByTestId("composer-context-fold")).toBeNull()
  })
})
