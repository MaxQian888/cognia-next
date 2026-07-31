/**
 * The store is a pure function OF the vendored provider's file list, so these
 * tests drive it exactly the way the composer does: mount the real
 * `PromptInputProvider`, call `attachments.add(...)`, and assert what the store
 * derives. Only `extractAttachment` is stubbed — it pulls in pdfjs/mammoth.
 */

jest.mock("@/lib/chat/attachments/dispatch", () => ({
  ...jest.requireActual("@/lib/chat/attachments/dispatch"),
  extractAttachment: jest.fn(),
}))

import { act, render, screen, waitFor } from "@testing-library/react"
import { useEffect } from "react"
import {
  PromptInputProvider,
  usePromptInputAttachments,
} from "@/components/ai-elements/prompt-input"
import { extractAttachment, type ExtractedAttachment } from "@/lib/chat/attachments/dispatch"
import {
  StagedAttachmentsProvider,
  useStagedAttachments,
  type StagedAttachmentsValue,
} from "./staged-attachment-store"

const extractMock = extractAttachment as jest.MockedFunction<typeof extractAttachment>

function docResult(text: string, tokens = 7): ExtractedAttachment {
  return { kind: "document", block: { type: "text", text }, tokens, text }
}

function imageResult(): ExtractedAttachment {
  return {
    kind: "image",
    block: { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
    tokens: 0,
    image: { mediaType: "image/png", bytes: 3 },
  }
}

/**
 * Captures the live store value + the provider's `add` so tests can drive both.
 * A single mutable object rather than separate `let`s: the react-hooks lint
 * forbids a component reassigning variables declared outside it.
 */
const captured: {
  store: StagedAttachmentsValue
  addFiles: (files: File[]) => void
  removeFile: (id: string) => void
  fileIds: string[]
} = {
  store: null as unknown as StagedAttachmentsValue,
  addFiles: () => {},
  removeFile: () => {},
  fileIds: [],
}

function Probe() {
  const store = useStagedAttachments()
  const attachments = usePromptInputAttachments()
  // Published from an effect, not the render body: reaching outside the
  // component is exactly what effects are for, and the react-hooks lint
  // rejects the same writes during render. No dep array — every commit
  // refreshes the handles a test is about to reach for.
  useEffect(() => {
    captured.store = store
    captured.addFiles = attachments.add
    captured.removeFile = attachments.remove
    captured.fileIds = attachments.files.map((f) => f.id)
  })
  return (
    <div>
      <span data-testid="status">
        {store.order.map((id) => store.byId.get(id)?.status ?? "?").join(",")}
      </span>
      <span data-testid="tokens">{store.totalTokens}</span>
      <span data-testid="bytes">{store.totalBytes}</span>
      <span data-testid="extracting">{String(store.isExtracting)}</span>
    </div>
  )
}

function mount() {
  return render(
    <PromptInputProvider>
      <StagedAttachmentsProvider>
        <Probe />
      </StagedAttachmentsProvider>
    </PromptInputProvider>
  )
}

const originalCreate = URL.createObjectURL
const originalRevoke = URL.revokeObjectURL
const originalFetch = global.fetch

beforeEach(() => {
  extractMock.mockReset()
  extractMock.mockResolvedValue(docResult('Attached file "a.txt":\n\nbody'))

  // jsdom has no object-URL store: hand out a stable fake and serve its bytes
  // back through a stubbed fetch, so the real FileReader path still runs.
  const blobs = new Map<string, Blob>()
  let seq = 0
  URL.createObjectURL = jest.fn((obj: Blob | MediaSource) => {
    const url = `blob:test/${seq++}`
    blobs.set(url, obj as Blob)
    return url
  })
  URL.revokeObjectURL = jest.fn()
  global.fetch = jest.fn(async (input: RequestInfo | URL) => {
    const blob = blobs.get(String(input))
    if (!blob) throw new Error(`no blob for ${String(input)}`)
    return { blob: async () => blob } as unknown as Response
  }) as unknown as typeof fetch
})

afterEach(() => {
  URL.createObjectURL = originalCreate
  URL.revokeObjectURL = originalRevoke
  global.fetch = originalFetch
})

function txt(name: string, body = "body text") {
  return new File([body], name, { type: "text/plain" })
}

describe("StagedAttachmentsProvider — extraction lifecycle", () => {
  it("marks a newly staged file as extracting, then ready with its token cost", async () => {
    mount()
    await act(async () => {
      captured.addFiles([txt("a.txt")])
    })
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("ready"))
    expect(screen.getByTestId("tokens")).toHaveTextContent("7")
    expect(screen.getByTestId("extracting")).toHaveTextContent("false")
  })

  it("records the real blob size, not a data-URL estimate", async () => {
    mount()
    await act(async () => {
      captured.addFiles([txt("a.txt", "0123456789")])
    })
    await waitFor(() => expect(screen.getByTestId("bytes")).toHaveTextContent("10"))
  })

  // Defensive fallback: a staged file whose URL is already a data: URL needs no
  // blob read. The provider only ever mints blob: URLs today, so this branch is
  // reachable only through that fallback path.
  it("skips the blob read for a file that already carries a data URL", async () => {
    URL.createObjectURL = jest.fn(() => "data:text/plain;base64,aGk=")
    mount()
    await act(async () => {
      captured.addFiles([txt("a.txt")])
    })
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("ready"))
    expect(global.fetch).not.toHaveBeenCalled()
    expect(screen.getByTestId("bytes")).toHaveTextContent("0")
  })

  it("stores no bytes for a data URL that is not base64-encoded", async () => {
    URL.createObjectURL = jest.fn(() => "data:text/plain,plain-text")
    mount()
    await act(async () => {
      captured.addFiles([txt("a.txt")])
    })
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("ready"))
    expect(captured.store.byId.get(captured.store.order[0]!)?.bytes).toBeUndefined()
  })

  it("survives a non-Error rejection from the extractor", async () => {
    extractMock.mockRejectedValue("plain string failure")
    mount()
    await act(async () => {
      captured.addFiles([txt("a.txt")])
    })
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("rejected"))
  })

  it("attributes a failed image extraction to the image kind", async () => {
    extractMock.mockRejectedValue(new Error("boom"))
    mount()
    await act(async () => {
      captured.addFiles([new File(["x"], "p.png", { type: "image/png" })])
    })
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("rejected"))
    expect(captured.store.byId.get(captured.store.order[0]!)?.extracted?.kind).toBe("image")
  })

  it("flags a rejected extraction without dropping the chip", async () => {
    extractMock.mockResolvedValue({
      kind: "document",
      block: null,
      tokens: 0,
      rejectReason: "unsupported-type",
    })
    mount()
    await act(async () => {
      captured.addFiles([txt("weird.xyz")])
    })
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("rejected"))
    expect(captured.store.precomputed.size).toBe(1)
    expect(captured.store.totalTokens).toBe(0)
  })

  it("marks the file rejected when extraction throws", async () => {
    extractMock.mockRejectedValue(new Error("boom"))
    mount()
    await act(async () => {
      captured.addFiles([txt("a.txt")])
    })
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("rejected"))
    expect(captured.store.byId.get(captured.store.order[0]!)?.extracted?.rejectReason).toBe(
      "parse-failed"
    )
  })

  it("extracts each file exactly once, even across re-renders", async () => {
    const { rerender } = mount()
    await act(async () => {
      captured.addFiles([txt("a.txt")])
    })
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("ready"))
    rerender(
      <PromptInputProvider>
        <StagedAttachmentsProvider>
          <Probe />
        </StagedAttachmentsProvider>
      </PromptInputProvider>
    )
    expect(extractMock).toHaveBeenCalledTimes(1)
  })

  it("extracts every file of a multi-file drop", async () => {
    mount()
    await act(async () => {
      captured.addFiles([txt("a.txt"), txt("b.txt"), txt("c.txt")])
    })
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("ready,ready,ready"))
    expect(extractMock).toHaveBeenCalledTimes(3)
    expect(screen.getByTestId("tokens")).toHaveTextContent("21")
  })
})

describe("StagedAttachmentsProvider — pruning", () => {
  it("drops derived state when a chip is removed", async () => {
    mount()
    await act(async () => {
      captured.addFiles([txt("a.txt"), txt("b.txt")])
    })
    await waitFor(() => expect(captured.store.order).toHaveLength(2))
    const doomed = captured.fileIds[0]!
    await act(async () => {
      captured.removeFile(doomed)
    })
    await waitFor(() => expect(captured.store.order).toHaveLength(1))
    expect(captured.store.byId.has(doomed)).toBe(false)
    expect(captured.store.precomputed.has(doomed)).toBe(false)
  })

  it("does not resurrect a chip removed while its extraction was in flight", async () => {
    let release!: (r: ExtractedAttachment) => void
    extractMock.mockImplementation(
      () => new Promise<ExtractedAttachment>((resolve) => (release = resolve))
    )
    mount()
    await act(async () => {
      captured.addFiles([txt("slow.txt")])
    })
    await waitFor(() => expect(captured.store.order).toHaveLength(1))
    const doomed = captured.fileIds[0]!
    await act(async () => {
      captured.removeFile(doomed)
    })
    await act(async () => {
      release(docResult("late"))
    })
    expect(captured.store.byId.has(doomed)).toBe(false)
    expect(captured.store.order).toHaveLength(0)
  })
})

describe("StagedAttachmentsProvider — ordering", () => {
  it("appends new ids and reorders on demand", async () => {
    mount()
    await act(async () => {
      captured.addFiles([txt("a.txt"), txt("b.txt"), txt("c.txt")])
    })
    await waitFor(() => expect(captured.store.order).toHaveLength(3))
    const [a, , c] = captured.store.order
    await act(async () => {
      captured.store.reorder(c!, a!)
    })
    expect(captured.store.order[0]).toBe(c)

    // A second reorder must build on the override, not the original order.
    await act(async () => {
      captured.store.reorder(a!, c!)
    })
    expect(captured.store.order[0]).toBe(a)
  })
})

describe("StagedAttachmentsProvider — whenSettled", () => {
  it("resolves immediately when nothing is in flight", async () => {
    mount()
    await expect(captured.store.whenSettled()).resolves.toBeUndefined()
  })

  // The flush effect only fires on a CHANGE of `isExtracting`, so a waiter
  // parked while idle must take a synchronous fast path or it hangs forever.
  it("resolves a waiter parked during an in-flight extraction", async () => {
    let release!: (r: ExtractedAttachment) => void
    extractMock.mockImplementation(
      () => new Promise<ExtractedAttachment>((resolve) => (release = resolve))
    )
    mount()
    await act(async () => {
      captured.addFiles([txt("slow.txt")])
    })
    await waitFor(() => expect(screen.getByTestId("extracting")).toHaveTextContent("true"))

    let settled = false
    const pending = captured.store.whenSettled().then(() => {
      settled = true
    })
    expect(settled).toBe(false)
    await act(async () => {
      release(docResult("done"))
    })
    await pending
    expect(settled).toBe(true)
  })
})

describe("StagedAttachmentsProvider — OCR opt-in", () => {
  it("stores OCR text and opts the image into the payload", async () => {
    extractMock.mockResolvedValue(imageResult())
    mount()
    await act(async () => {
      captured.addFiles([new File(["x"], "shot.png", { type: "image/png" })])
    })
    await waitFor(() => expect(captured.store.order).toHaveLength(1))
    const id = captured.store.order[0]!
    expect(captured.store.byId.get(id)?.includeOcr).toBeUndefined()
    await act(async () => {
      captured.store.setOcrText(id, "recognised words")
    })
    expect(captured.store.byId.get(id)?.ocrText).toBe("recognised words")
    expect(captured.store.byId.get(id)?.includeOcr).toBe(true)
    expect(captured.store.precomputed.get(id)?.ocr?.text).toContain("recognised words")
    expect(captured.store.totalTokens).toBeGreaterThan(0)
    await act(async () => {
      captured.store.toggleIncludeOcr(id)
    })
    expect(captured.store.byId.get(id)?.includeOcr).toBe(false)
    expect(captured.store.precomputed.get(id)?.ocr).toBeUndefined()
    expect(captured.store.totalTokens).toBe(0)
  })

  it("ignores OCR mutations for an unknown id", async () => {
    mount()
    await act(async () => {
      captured.store.setOcrText("ghost", "x")
      captured.store.toggleIncludeOcr("ghost")
    })
    expect(captured.store.byId.has("ghost")).toBe(false)
  })
})

describe("StagedAttachmentsProvider — seeding a restored draft", () => {
  // The provider mints ids internally and `add()` returns nothing, so a
  // restored draft cannot address its file by id. Entries are matched by
  // filename instead, and must be queued BEFORE the file is staged.
  it("adopts a queued extraction instead of re-parsing the restored file", async () => {
    mount()
    const seeded = {
      status: "ready" as const,
      sizeBytes: 42,
      extracted: docResult("from draft", 99),
    }
    await act(async () => {
      captured.store.seedIncoming([{ filename: "a.txt", sizeBytes: 42, state: seeded }])
      captured.addFiles([txt("a.txt")])
    })
    await waitFor(() => expect(captured.store.order).toHaveLength(1))
    const id = captured.store.order[0]!
    expect(extractMock).not.toHaveBeenCalled()
    expect(captured.store.byId.get(id)?.sizeBytes).toBe(42)
    expect(captured.store.totalTokens).toBe(99)
  })

  it("still extracts a staged file that no queued entry matches", async () => {
    mount()
    await act(async () => {
      captured.store.seedIncoming([
        {
          filename: "other.txt",
          sizeBytes: 1,
          state: { status: "ready", sizeBytes: 1, extracted: docResult("x") },
        },
      ])
      captured.addFiles([txt("a.txt")])
    })
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("ready"))
    expect(extractMock).toHaveBeenCalledTimes(1)
  })

  it("consumes each queued entry only once", async () => {
    mount()
    const seeded = {
      status: "ready" as const,
      sizeBytes: 7,
      extracted: docResult("from draft", 3),
    }
    await act(async () => {
      captured.store.seedIncoming([{ filename: "dup.txt", sizeBytes: 7, state: seeded }])
      captured.addFiles([txt("dup.txt"), txt("dup.txt")])
    })
    await waitFor(() => expect(captured.store.order).toHaveLength(2))
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("ready,ready"))
    // First file adopted the entry; the second had to be parsed for real.
    expect(extractMock).toHaveBeenCalledTimes(1)
  })
})

describe("useStagedAttachments", () => {
  it("throws outside the provider", () => {
    const Bare = () => {
      useStagedAttachments()
      return null
    }
    const spy = jest.spyOn(console, "error").mockImplementation(() => {})
    expect(() => render(<Bare />)).toThrow(/StagedAttachmentsProvider/)
    spy.mockRestore()
  })
})
