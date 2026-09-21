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
jest.mock("@/lib/chat/attachments/video/preprocess", () => ({
  preprocessMotionAttachment: jest.fn(),
}))

import { act, render, screen, waitFor } from "@testing-library/react"
import { useEffect } from "react"
import {
  PromptInputProvider,
  usePromptInputAttachments,
} from "@/components/ai-elements/prompt-input"
import { extractAttachment, type ExtractedAttachment } from "@/lib/chat/attachments/dispatch"
import {
  preprocessMotionAttachment,
  type MotionPreprocessRequest,
  type VideoPreprocessResult,
} from "@/lib/chat/attachments/video/preprocess"
import { VideoPreprocessError } from "@/lib/chat/attachments/video/frame-source"
import { DEFAULT_VIDEO_SETTINGS } from "@/lib/chat/attachments/video/settings"
import { sha256Blob } from "@/lib/ocr/hash"
import { prepareComposerAttachments } from "@/lib/chat/attachments/prepare"
import {
  StagedAttachmentsProvider,
  useStagedAttachments,
  type StagedAttachmentsValue,
} from "./staged-attachment-store"

const extractMock = extractAttachment as jest.MockedFunction<typeof extractAttachment>
const preprocessMock = preprocessMotionAttachment as jest.MockedFunction<
  typeof preprocessMotionAttachment
>

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

function mount({ motion }: { motion?: boolean } = {}) {
  return render(
    <PromptInputProvider>
      <StagedAttachmentsProvider {...(motion === undefined ? {} : { motion })}>
        <Probe />
      </StagedAttachmentsProvider>
    </PromptInputProvider>
  )
}

const originalCreate = URL.createObjectURL
const originalRevoke = URL.revokeObjectURL
const originalFetch = global.fetch

beforeEach(() => {
  preprocessMock.mockReset()
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
  it("retains uploaded original bytes even when intake resized the model image", async () => {
    const original = new File(["original-image-bytes"], "picture.png", { type: "image/png" })
    const prepared = await prepareComposerAttachments([original], {
      maxFileSize: 5,
      optimizeImage: async () => new File(["tiny"], "picture.png", { type: "image/png" }),
    })
    extractMock.mockResolvedValue({
      ...imageResult(),
      extractedContent: {
        attachmentId: "staged",
        contentHash: "a".repeat(64),
        status: "partial",
        segments: [],
        processor: { id: "image", version: "1" },
      },
    })
    mount()
    await act(async () => captured.addFiles(prepared.files))
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("ready"))
    const state = captured.store.byId.get(captured.store.order[0]!)!
    expect(state.extracted?.original).toBe(original)
    expect(state.extracted?.extractedContent?.contentHash).toBe(await sha256Blob(original))
    expect(new TextDecoder().decode(state.bytes)).toBe("original-image-bytes")
  })
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

  it("lands a slow extraction even when another file is staged while it runs", async () => {
    let release!: (r: ExtractedAttachment) => void
    extractMock.mockImplementationOnce(
      () => new Promise<ExtractedAttachment>((resolve) => (release = resolve))
    )
    mount()
    await act(async () => {
      captured.addFiles([txt("slow.txt")])
    })
    await waitFor(() => expect(extractMock).toHaveBeenCalledTimes(1))
    await act(async () => {
      captured.addFiles([txt("fast.txt")])
    })
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("extracting,ready"))
    await act(async () => {
      release(docResult("slow body", 5))
    })
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("ready,ready"))
    expect(screen.getByTestId("extracting")).toHaveTextContent("false")
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
    const source = txt("a.txt")
    const seeded = {
      status: "ready" as const,
      sizeBytes: 42,
      extracted: {
        ...docResult("from draft", 99),
        extractedContent: {
          attachmentId: "old-id",
          contentHash: await sha256Blob(source),
          status: "ready" as const,
          segments: [
            {
              id: "body",
              text: "from draft",
              locator: { type: "text" as const, start: 0, end: 10 },
            },
          ],
          processor: { id: "text", version: "1" },
        },
      },
    }
    await act(async () => {
      captured.store.seedIncoming([{ filename: "a.txt", sizeBytes: 42, state: seeded }])
      captured.addFiles([source])
    })
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("ready"))
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
    const source = txt("dup.txt")
    const seeded = {
      status: "ready" as const,
      sizeBytes: 7,
      extracted: {
        ...docResult("from draft", 3),
        extractedContent: {
          attachmentId: "old-id",
          contentHash: await sha256Blob(source),
          status: "ready" as const,
          segments: [],
          processor: { id: "text", version: "1" },
        },
      },
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

  it("reparses legacy or mismatched draft caches instead of trusting filenames", async () => {
    mount()
    await act(async () => {
      captured.store.seedIncoming([
        {
          filename: "legacy.txt",
          sizeBytes: 9,
          state: { status: "ready", sizeBytes: 9, extracted: docResult("stale") },
        },
        {
          filename: "mismatch.txt",
          sizeBytes: 9,
          state: {
            status: "ready",
            sizeBytes: 9,
            extracted: {
              ...docResult("stale"),
              extractedContent: {
                attachmentId: "old",
                contentHash: "a".repeat(64),
                status: "ready",
                segments: [],
                processor: { id: "text", version: "1" },
              },
            },
          },
        },
      ])
      captured.addFiles([txt("legacy.txt"), txt("mismatch.txt")])
    })
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("ready,ready"))
    expect(extractMock).toHaveBeenCalledTimes(2)
    for (const state of captured.store.byId.values())
      expect(state.extracted?.text).not.toBe("stale")
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

describe("StagedAttachmentsProvider — videos", () => {
  function videoResult(overrides: Partial<VideoPreprocessResult> = {}): VideoPreprocessResult {
    return {
      engine: "browser",
      source: { kind: "video", mediaType: "video/mp4", durationSec: 20, width: 640, height: 360 },
      settings: DEFAULT_VIDEO_SETTINGS,
      sampled: {
        delivery: "storyboard",
        frames: [{ timeSec: 1, reason: "uniform" }],
        grid: { columns: 1, rows: 1 },
        images: [
          { mediaType: "image/jpeg", base64: "Qk9BUkQ=", bytes: 5, width: 640, height: 360 },
        ],
        description: 'Attached video "clip.mp4" (20.0s, 640×360).',
        blocks: [
          { type: "text", text: 'Attached video "clip.mp4" (20.0s, 640×360).' },
          { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "Qk9BUkQ=" } },
        ],
        estimatedImageTokens: 308,
      },
      native: null,
      nativeFailure: null,
      nativeTrimSupported: false,
      poster: { mediaType: "image/jpeg", base64: "UE9TVEVS", bytes: 6, width: 512, height: 288 },
      ...overrides,
    }
  }
  const clip = (name = "clip.mp4", size = 16) =>
    new File([new Uint8Array(size)], name, { type: "video/mp4" })

  it("samples a video through the motion pipeline, never as a data URL", async () => {
    const readAsDataURL = jest.spyOn(FileReader.prototype, "readAsDataURL")
    preprocessMock.mockResolvedValue({ kind: "motion", result: videoResult() })
    mount()
    await act(async () => {
      captured.addFiles([clip()])
    })
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("ready"))
    expect(extractMock).not.toHaveBeenCalled()
    expect(readAsDataURL).not.toHaveBeenCalled()
    readAsDataURL.mockRestore()

    const request = preprocessMock.mock.calls[0]![0] as MotionPreprocessRequest
    expect(request).toMatchObject({ filename: "clip.mp4", mediaType: "video/mp4" })
    expect(request.settings).toEqual(DEFAULT_VIDEO_SETTINGS)
    const id = captured.store.order[0]!
    const state = captured.store.byId.get(id)!
    expect(state.extracted?.kind).toBe("video")
    expect(state.extracted?.video?.sampled.info.groupId).toBe(id)
    expect(state.video?.result).toBeDefined()
    expect(state.bytes?.byteLength).toBe(16)
    expect(captured.store.precomputed.get(id)?.kind).toBe("video")
  })

  it("keeps no draft bytes for a source above the native ceiling", async () => {
    preprocessMock.mockResolvedValue({ kind: "motion", result: videoResult() })
    mount()
    const big = { size: 10 * 1024 * 1024 + 1 }
    await act(async () => {
      const file = clip()
      Object.defineProperty(file, "size", { value: big.size })
      captured.addFiles([file])
    })
    // The fetch stub serves the staged File back, so its patched size carries.
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("ready"))
    expect(captured.store.byId.get(captured.store.order[0]!)?.bytes).toBeUndefined()
  })

  it("reports progress while a run is in flight and holds the send", async () => {
    let finish!: () => void
    preprocessMock.mockImplementation(async (request) => {
      request.onProgress?.(0.5)
      await new Promise<void>((resolve) => (finish = resolve))
      return { kind: "motion", result: videoResult() }
    })
    mount()
    await act(async () => {
      captured.addFiles([clip()])
    })
    await waitFor(() =>
      expect(captured.store.byId.get(captured.store.order[0]!)?.video?.progress).toBe(0.5)
    )
    expect(screen.getByTestId("status")).toHaveTextContent("extracting")
    expect(screen.getByTestId("extracting")).toHaveTextContent("true")
    await act(async () => {
      finish()
    })
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("ready"))
  })

  it("re-runs with applied settings and ignores the run it replaced", async () => {
    const releases: Array<() => void> = []
    const signals: AbortSignal[] = []
    preprocessMock.mockImplementation(async (request) => {
      signals.push(request.signal!)
      await new Promise<void>((resolve) => releases.push(resolve))
      return {
        kind: "motion",
        result: videoResult({ settings: request.settings }),
      }
    })
    mount()
    await act(async () => {
      captured.addFiles([clip()])
    })
    await waitFor(() => expect(preprocessMock).toHaveBeenCalledTimes(1))
    const id = captured.store.order[0]!
    const frames = { ...DEFAULT_VIDEO_SETTINGS, delivery: "frames" as const, frameCount: 3 }
    await act(async () => {
      captured.store.applyVideoSettings(id, frames)
    })
    await waitFor(() => expect(preprocessMock).toHaveBeenCalledTimes(2))
    expect(signals[0]!.aborted).toBe(true)
    await act(async () => {
      releases[0]!()
      releases[1]!()
    })
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("ready"))
    expect(captured.store.byId.get(id)?.video?.settings).toEqual(frames)
  })

  it("marks an undecodable video rejected with the reason and the ffmpeg verdict", async () => {
    preprocessMock.mockRejectedValue(
      new VideoPreprocessError("undecodable", "no codec", "not-available-here")
    )
    mount()
    await act(async () => {
      captured.addFiles([clip("x.mkv")])
    })
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("rejected"))
    const state = captured.store.byId.get(captured.store.order[0]!)!
    expect(state.extracted).toMatchObject({ kind: "video", rejectReason: "video-undecodable" })
    expect(state.video?.error).toEqual({
      reason: "undecodable",
      ffmpeg: "not-available-here",
      message: "no codec",
    })
  })

  it("maps a too-large source and a generic failure to their reasons", async () => {
    preprocessMock
      .mockRejectedValueOnce(new VideoPreprocessError("too-large", "big"))
      .mockRejectedValueOnce(new Error("boom"))
    mount()
    await act(async () => {
      captured.addFiles([clip("a.mp4"), clip("b.mp4")])
    })
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("rejected,rejected"))
    const reasons = captured.store.order.map(
      (id) => captured.store.byId.get(id)?.extracted?.rejectReason
    )
    expect(reasons.sort()).toEqual(["parse-failed", "video-too-large"])
  })

  it("sends a still GIF down the image path", async () => {
    preprocessMock.mockResolvedValue({ kind: "still-gif" })
    extractMock.mockResolvedValue(imageResult())
    mount()
    await act(async () => {
      captured.addFiles([new File(["GIF89a"], "still.gif", { type: "image/gif" })])
    })
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("ready"))
    expect(extractMock).toHaveBeenCalledTimes(1)
    expect(captured.store.byId.get(captured.store.order[0]!)?.video).toBeUndefined()
  })

  it("forwards a GIF as a picture when the motion pipeline is off", async () => {
    extractMock.mockResolvedValue(imageResult())
    mount({ motion: false })
    await act(async () => {
      captured.addFiles([new File(["GIF89a"], "loop.gif", { type: "image/gif" })])
    })
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("ready"))
    expect(preprocessMock).not.toHaveBeenCalled()
    expect(extractMock).toHaveBeenCalledTimes(1)
  })

  it("cancels the run of a chip that is removed", async () => {
    let signal!: AbortSignal
    preprocessMock.mockImplementation(async (request) => {
      signal = request.signal!
      await new Promise(() => {})
      return { kind: "still-gif" }
    })
    mount()
    await act(async () => {
      captured.addFiles([clip()])
    })
    await waitFor(() => expect(preprocessMock).toHaveBeenCalled())
    await act(async () => {
      captured.removeFile(captured.fileIds[0]!)
    })
    expect(signal.aborted).toBe(true)
  })

  it("re-runs a restored draft video with the settings it was saved with", async () => {
    preprocessMock.mockResolvedValue({ kind: "motion", result: videoResult() })
    const saved = { ...DEFAULT_VIDEO_SETTINGS, strategy: "scene" as const, frameCount: 12 }
    mount()
    await act(async () => {
      captured.store.seedIncoming([
        {
          filename: "clip.mp4",
          sizeBytes: 16,
          state: { status: "ready", sizeBytes: 16, video: { settings: saved } },
        },
      ])
      captured.addFiles([clip()])
    })
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("ready"))
    expect(preprocessMock.mock.calls[0]![0].settings).toEqual(saved)
  })

  it("preserves verified transcripts when video sampling is changed and retried", async () => {
    const source = clip()
    const segment = {
      id: "transcript",
      text: "Release on Friday",
      locator: { type: "time" as const, startSec: 1, endSec: 4 },
      derivation: "transcription" as const,
    }
    const restoredContent = {
      attachmentId: "old",
      contentHash: await sha256Blob(source),
      status: "partial" as const,
      segments: [segment],
      processor: { id: "transcriber", version: "1" },
    }
    preprocessMock.mockResolvedValue({ kind: "motion", result: videoResult() })
    mount()
    await act(async () => {
      captured.store.seedIncoming([
        {
          filename: "clip.mp4",
          sizeBytes: source.size,
          state: { status: "ready", sizeBytes: source.size, restoredContent },
        },
      ])
      captured.addFiles([source])
    })
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("ready"))
    const id = captured.store.order[0]!
    await act(async () =>
      captured.store.applyVideoSettings(id, { ...DEFAULT_VIDEO_SETTINGS, frameCount: 3 })
    )
    await waitFor(() => expect(preprocessMock).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("ready"))
    expect(captured.store.byId.get(id)?.extracted?.extractedContent?.segments).toEqual([segment])
    expect(captured.store.byId.get(id)?.extracted?.video?.sampled.blocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "text",
          text: expect.stringContaining("Release on Friday"),
        }),
      ])
    )
    await act(async () => captured.store.retry(id))
    await waitFor(() => expect(preprocessMock).toHaveBeenCalledTimes(3))
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("ready"))
    expect(captured.store.byId.get(id)?.extracted?.extractedContent?.segments).toEqual([segment])
  })

  it("ignores applied settings for an unknown id", async () => {
    mount()
    await act(async () => {
      captured.store.applyVideoSettings("ghost", DEFAULT_VIDEO_SETTINGS)
    })
    expect(preprocessMock).not.toHaveBeenCalled()
  })
})
