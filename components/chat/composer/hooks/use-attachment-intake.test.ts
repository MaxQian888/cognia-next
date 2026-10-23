/** @jest-environment jsdom */
import { act, renderHook, waitFor } from "@testing-library/react"

import { useAttachmentIntake } from "./use-attachment-intake"

jest.mock("sonner", () => ({
  toast: {
    success: jest.fn(),
    error: jest.fn(),
    warning: jest.fn(),
    message: jest.fn(),
    loading: jest.fn(),
    dismiss: jest.fn(),
  },
}))
jest.mock("@cognia/logging", () => ({ loggers: { chat: { warn: jest.fn(), error: jest.fn() } } }))
jest.mock("@/lib/chat/attachments/prepare", () => ({
  COMPOSER_MAX_ATTACHMENTS: 3,
  COMPOSER_MAX_ATTACHMENT_BYTES: 1024,
  COMPOSER_VIDEO_SOURCE_MAX_BYTES: 4 * 1024 * 1024,
  prepareComposerAttachments: jest.fn(),
}))
jest.mock("@/lib/chat/smart-snapshot", () => ({
  captureSmartSnapshotFiles: jest.fn(),
  SMART_SNAPSHOT_COMMAND_ID: "chat.smartSnapshot",
}))
jest.mock("@/lib/chat/drop-entries", () => ({
  collectDroppedFiles: jest.fn(),
  MAX_DROPPED_DIR_FILES: 50,
}))
jest.mock("@/lib/tauri/pet-window", () => ({ showMainWindow: jest.fn() }))
jest.mock("@/stores/chat", () => ({
  useChatStore: { getState: () => ({ activeSessionId: null }) },
}))
jest.mock("@/hooks/chat/use-remote-doc-staging", () => ({
  useRemoteDocStaging: jest.fn(() => async () => undefined),
}))
jest.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))
jest.mock("@/lib/docs-providers", () => ({
  ...jest.requireActual("@/lib/docs-providers/types"),
  getDocsProvider: jest.fn(),
}))

import { toast } from "sonner"
import { prepareComposerAttachments } from "@/lib/chat/attachments/prepare"
import { captureSmartSnapshotFiles, SMART_SNAPSHOT_COMMAND_ID } from "@/lib/chat/smart-snapshot"
import {
  __resetCommandRegistryForTesting,
  executeCommand,
  getCommand,
} from "@/lib/plugin/commands/registry"
import { collectDroppedFiles } from "@/lib/chat/drop-entries"
import { useRemoteDocStaging } from "@/hooks/chat/use-remote-doc-staging"
import { getDocsProvider } from "@/lib/docs-providers"

const prepared = prepareComposerAttachments as jest.Mock
const snapshot = captureSmartSnapshotFiles as jest.Mock
const dropped = collectDroppedFiles as jest.Mock

function file(name: string, type = "text/plain") {
  return new File(["x"], name, { type })
}

/** Mounts the hook over a controllable text buffer + attachment sink. */
function mount(
  opts: { isDesktop?: boolean; staged?: number; initialText?: string; acceptMotion?: boolean } = {}
) {
  const add = jest.fn()
  const sink = { add }
  const expectCitation = jest.fn()
  const setInput = jest.fn()
  const setCaret = jest.fn()
  // Identity translators, but recorded — several gate messages carry the limit
  // as an ICU value, and the key alone would not prove the right number reached
  // the user.
  const tAttach = jest.fn((k: string) => k)
  const textarea = document.createElement("textarea")
  const root = document.createElement("div")
  root.dataset.composerRoot = ""
  root.append(textarea)
  document.body.append(root)
  const textareaRef = { current: textarea }
  const t = (k: string) => k
  const state = { value: opts.initialText ?? "" }
  const view = renderHook(() =>
    useAttachmentIntake({
      attachments: { files: new Array(opts.staged ?? 0).fill(null), add: sink.add },
      attachmentCitations: { expect: expectCitation },
      textInput: {
        get value() {
          return state.value
        },
        setInput: (next: string) => {
          state.value = next
          setInput(next)
        },
      },
      textareaRef,
      setCaret,
      isDesktop: opts.isDesktop ?? true,
      acceptMotion: opts.acceptMotion ?? true,
      t,
      tAttach,
    })
  )
  return { view, add, sink, expectCitation, setInput, setCaret, state, textarea, root, tAttach }
}

/** A paste event carrying only text (no files). */
function textPaste(text: string) {
  const preventDefault = jest.fn()
  return {
    preventDefault,
    clipboardData: { items: [], getData: () => text },
  } as never
}

function fileDrag(types: string[]) {
  const preventDefault = jest.fn()
  return { preventDefault, dataTransfer: { types } } as never
}

beforeEach(() => {
  jest.clearAllMocks()
  jest.mocked(useRemoteDocStaging).mockImplementation(() => async () => null)
  __resetCommandRegistryForTesting()
  prepared.mockResolvedValue({
    files: [],
    unsupportedCount: 0,
    tooLargeCount: 0,
    optimizedCount: 0,
    motionTooLargeCount: 0,
  })
})

afterEach(() => {
  document.body.replaceChildren()
})

describe("acceptFiles — the single gate", () => {
  it("checks destination again after asynchronous identity validation, without announcing or adding", async () => {
    const f = file("doc.md")
    prepared.mockResolvedValue({
      files: [f],
      unsupportedCount: 0,
      tooLargeCount: 0,
      optimizedCount: 0,
    })
    let finish!: (valid: boolean) => void
    let current = true
    const beforeCommit = jest.fn(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve
        })
    )
    const { view, add, expectCitation } = mount()
    let pending!: Promise<File[]>
    act(() => {
      pending = view.result.current.acceptFiles([f], {
        isCurrent: () => current,
        beforeCommit,
        citations: new Map([[f, { kind: "doc", id: "doc" }]]),
      })
    })
    await waitFor(() => expect(beforeCommit).toHaveBeenCalled())
    current = false
    await act(async () => {
      finish(true)
      expect(await pending).toEqual([])
    })
    expect(add).not.toHaveBeenCalled()
    expect(expectCitation).not.toHaveBeenCalled()
  })

  it("real remote staging discards a fetch after changing conversations", async () => {
    jest
      .mocked(useRemoteDocStaging)
      .mockImplementation(
        jest.requireActual("@/hooks/chat/use-remote-doc-staging").useRemoteDocStaging
      )
    let finish!: (value: unknown) => void
    jest.mocked(getDocsProvider).mockReturnValue({
      id: "test",
      fetch: () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    } as never)
    const { view, root, add, expectCitation } = mount()
    root.dataset.composerSession = "old"
    let pending!: Promise<File | null>
    act(() => {
      pending = view.result.current.stageRemoteDoc({
        providerId: "test",
        accountId: "a",
        doc: { providerId: "test", kind: "doc", id: "id", title: "Doc" },
      })
    })
    root.dataset.composerSession = "new"
    await act(async () => {
      finish({
        ref: { providerId: "test", id: "id", kind: "doc", title: "Doc" },
        title: "Doc",
        text: "body",
        format: "text",
      })
      expect(await pending).toBeNull()
    })
    expect(add).not.toHaveBeenCalled()
    expect(expectCitation).not.toHaveBeenCalled()
  })

  it("real remote staging rejects an epoch change during preparation and keeps a concurrent local attachment", async () => {
    jest
      .mocked(useRemoteDocStaging)
      .mockImplementation(
        jest.requireActual("@/hooks/chat/use-remote-doc-staging").useRemoteDocStaging
      )
    let epoch = "old"
    jest.mocked(getDocsProvider).mockReturnValue({
      id: "test",
      listAccounts: async () => [{ id: "a", label: "A", authorizationEpoch: epoch }],
      fetch: async (ref: unknown) => ({ ref, title: "Doc", text: "body", format: "text" }),
    } as never)
    let release!: (value: unknown) => void
    prepared.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve
        })
    )
    const { view, add, expectCitation } = mount()
    let pending!: Promise<File | null>
    act(() => {
      pending = view.result.current.stageRemoteDoc({
        providerId: "test",
        accountId: "a",
        doc: {
          providerId: "test",
          kind: "doc",
          id: "id",
          title: "Doc",
          accountBinding: { accountId: "a", authorizationEpoch: "old" },
        },
      })
    })
    await waitFor(() => expect(prepared).toHaveBeenCalledTimes(1))
    const remote = prepared.mock.calls[0][0][0] as File
    const local = file("local.txt")
    prepared.mockResolvedValue({
      files: [local],
      unsupportedCount: 0,
      tooLargeCount: 0,
      optimizedCount: 0,
    })
    await act(async () => {
      await view.result.current.acceptFiles([local])
    })
    epoch = "new"
    await act(async () => {
      release({ files: [remote], unsupportedCount: 0, tooLargeCount: 0, optimizedCount: 0 })
      expect(await pending).toBeNull()
    })
    expect(add.mock.calls).toEqual([[[local]]])
    expect(expectCitation).not.toHaveBeenCalled()
  })
  it("does not prepare files for a destination that already left", async () => {
    const { view, add } = mount()
    await expect(
      view.result.current.acceptFiles([file("photo.png", "image/png")], {
        isCurrent: () => false,
      })
    ).resolves.toEqual([])
    expect(prepared).not.toHaveBeenCalled()
    expect(add).not.toHaveBeenCalled()
  })

  it("discards prepared images after their destination changes without emitting notifications", async () => {
    const photo = file("photo.png", "image/png")
    let finish!: (value: unknown) => void
    prepared.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve
      })
    )
    const { view, add, expectCitation } = mount()
    let current = true
    let pending!: Promise<File[]>
    act(() => {
      pending = view.result.current.acceptFiles([photo], { isCurrent: () => current })
    })
    expect(view.result.current.isPreparingAttachments).toBe(true)
    current = false
    await act(async () => {
      finish({ files: [photo], unsupportedCount: 1, tooLargeCount: 1, optimizedCount: 1 })
      await expect(pending).resolves.toEqual([])
    })
    expect(add).not.toHaveBeenCalled()
    expect(expectCitation).not.toHaveBeenCalled()
    expect(toast.warning).not.toHaveBeenCalled()
    expect(toast.success).not.toHaveBeenCalled()
    expect(view.result.current.isPreparingAttachments).toBe(false)
    expect(view.result.current.preparingImageCount).toBe(0)
  })

  it("stages prepared files", async () => {
    const f = file("a.txt")
    prepared.mockResolvedValue({
      files: [f],
      unsupportedCount: 0,
      tooLargeCount: 0,
      optimizedCount: 0,
    })
    const { view, add } = mount()
    await act(async () => {
      await view.result.current.acceptFiles([f])
    })
    expect(add).toHaveBeenCalledWith([f])
  })

  it("opts the gate into video preprocessing with the source ceiling", async () => {
    const { view } = mount()
    await act(async () => {
      await view.result.current.acceptFiles([file("clip.mp4", "video/mp4")])
    })
    expect(prepared).toHaveBeenCalledWith(expect.any(Array), {
      maxFileSize: 1024,
      motion: { maxSourceBytes: 4 * 1024 * 1024 },
      audio: true,
    })
  })

  it("leaves video out when the conversation does not preprocess", async () => {
    const { view } = mount({ acceptMotion: false })
    await act(async () => {
      await view.result.current.acceptFiles([file("clip.mp4", "video/mp4")])
    })
    expect(prepared).toHaveBeenCalledWith(expect.any(Array), { maxFileSize: 1024, audio: false })
  })

  it("warns with the video ceiling in megabytes", async () => {
    prepared.mockResolvedValue({
      files: [],
      unsupportedCount: 0,
      tooLargeCount: 0,
      optimizedCount: 0,
      motionTooLargeCount: 2,
    })
    const { view, tAttach } = mount()
    await act(async () => {
      await view.result.current.acceptFiles([file("a.mov", "video/quicktime")])
    })
    expect(tAttach).toHaveBeenCalledWith("videoSizeExceeded", { count: 2, max: 4 })
    expect(toast.warning).toHaveBeenCalledWith("videoSizeExceeded")
  })

  it("truncates to the remaining headroom and warns", async () => {
    prepared.mockResolvedValue({
      files: [file("a"), file("b"), file("c")],
      unsupportedCount: 0,
      tooLargeCount: 0,
      optimizedCount: 0,
    })
    // 2 already staged, cap is 3 → only 1 may land.
    const { view, add, tAttach } = mount({ staged: 2 })
    await act(async () => {
      await view.result.current.acceptFiles([file("a")])
    })
    expect(add.mock.calls[0][0]).toHaveLength(1)
    expect(toast.warning).toHaveBeenCalledWith("countLimit")
    expect(tAttach).toHaveBeenCalledWith("countLimit", { max: 3 })
  })

  it("resolves to exactly the files it staged", async () => {
    const [a, b, c] = [file("a"), file("b"), file("c")]
    prepared.mockResolvedValue({
      files: [a, b, c],
      unsupportedCount: 0,
      tooLargeCount: 0,
      optimizedCount: 0,
    })
    const { view } = mount({ staged: 2 })
    let staged: File[] = []
    await act(async () => {
      staged = await view.result.current.acceptFiles([a, b, c])
    })
    expect(staged).toEqual([a])
  })

  // A remote document's citation can only find its attachment id if it is
  // announced before `add()` mints that id.
  it("announces a carried citation immediately before staging the file", async () => {
    const doc = file("Plan.md", "text/markdown")
    const other = file("notes.txt")
    prepared.mockResolvedValue({
      files: [doc, other],
      unsupportedCount: 0,
      tooLargeCount: 0,
      optimizedCount: 0,
    })
    const citation = { kind: "doc" as const, id: "lark:doc_1", label: "Plan" }
    const { view, add, expectCitation } = mount()
    await act(async () => {
      await view.result.current.acceptFiles([doc, other], {
        citations: new Map([[doc, citation]]),
      })
    })
    expect(expectCitation).toHaveBeenCalledTimes(1)
    expect(expectCitation).toHaveBeenCalledWith(doc, citation)
    expect(expectCitation.mock.invocationCallOrder[0]).toBeLessThan(
      add.mock.invocationCallOrder[0]!
    )
  })

  it("announces no citation for a file the gate refused", async () => {
    const doc = file("Plan.md", "text/markdown")
    const { view, add, expectCitation } = mount()
    let staged: File[] = [doc]
    await act(async () => {
      staged = await view.result.current.acceptFiles([doc], {
        citations: new Map([[doc, { kind: "doc" as const, id: "lark:doc_1" }]]),
      })
    })
    expect(staged).toEqual([])
    expect(add).not.toHaveBeenCalled()
    expect(expectCitation).not.toHaveBeenCalled()
  })

  it("does not call add when nothing survives preparation", async () => {
    const { view, add } = mount()
    await act(async () => {
      await view.result.current.acceptFiles([file("a")])
    })
    expect(add).not.toHaveBeenCalled()
  })

  it("clears the in-flight counter even when preparation throws", async () => {
    prepared.mockRejectedValue(new Error("boom"))
    const { view } = mount()
    await act(async () => {
      await view.result.current.acceptFiles([file("a")]).catch(() => {})
    })
    expect(view.result.current.isPreparingAttachments).toBe(false)
  })

  it("counts only images toward the scan placeholder", async () => {
    let release: (v: unknown) => void = () => {}
    prepared.mockReturnValue(
      new Promise((resolve) => {
        release = resolve
      })
    )
    const { view } = mount()
    act(() => {
      void view.result.current.acceptFiles([file("a.png", "image/png"), file("b.txt")])
    })
    await waitFor(() => expect(view.result.current.preparingImageCount).toBe(1))
    await act(async () => {
      release({ files: [], unsupportedCount: 0, tooLargeCount: 0, optimizedCount: 0 })
    })
    await waitFor(() => expect(view.result.current.preparingImageCount).toBe(0))
  })
})

describe("paste folding", () => {
  it("folds an oversized paste into a placeholder and stores the body", async () => {
    const big = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n")
    const { view, state } = mount()
    act(() => {
      view.result.current.onPaste(textPaste(big))
    })
    const placeholders = Object.keys(view.result.current.pastedBlocks)
    expect(placeholders).toHaveLength(1)
    expect(placeholders[0]).toMatch(/^\[Pasted 40 lines #\d+\]$/)
    expect(view.result.current.pastedBlocks[placeholders[0]]).toBe(big)
    expect(state.value).toContain(placeholders[0])
  })

  it("lets a small paste through to the native insert", () => {
    const { view, setInput } = mount()
    act(() => {
      view.result.current.onPaste(textPaste("just a line"))
    })
    expect(view.result.current.pastedBlocks).toEqual({})
    expect(setInput).not.toHaveBeenCalled()
  })

  it("gives consecutive folds distinct placeholders", () => {
    const big = Array.from({ length: 12 }, () => "x").join("\n")
    const { view } = mount()
    act(() => {
      view.result.current.onPaste(textPaste(big))
    })
    act(() => {
      view.result.current.onPaste(textPaste(big))
    })
    expect(Object.keys(view.result.current.pastedBlocks)).toHaveLength(2)
  })

  it("removePastedBlock drops both the placeholder and the stored body", () => {
    const big = Array.from({ length: 12 }, () => "x").join("\n")
    const { view, state } = mount()
    act(() => {
      view.result.current.onPaste(textPaste(big))
    })
    const ph = Object.keys(view.result.current.pastedBlocks)[0]
    act(() => {
      view.result.current.removePastedBlock(ph)
    })
    expect(view.result.current.pastedBlocks).toEqual({})
    expect(state.value).not.toContain(ph)
  })
})

describe("drag depth", () => {
  it("shows the overlay only while a file drag is over the box", () => {
    const { view } = mount()
    expect(view.result.current.isDragging).toBe(false)
    act(() => view.result.current.onDragEnter(fileDrag(["Files"])))
    expect(view.result.current.isDragging).toBe(true)
    act(() => view.result.current.onDragLeave(fileDrag(["Files"])))
    expect(view.result.current.isDragging).toBe(false)
  })

  it("ignores non-file drags on BOTH edges so the counter cannot desync", () => {
    const { view } = mount()
    act(() => view.result.current.onDragEnter(fileDrag(["Files"])))
    // A text drag leaving must not decrement a depth it never incremented.
    act(() => view.result.current.onDragLeave(fileDrag(["text/plain"])))
    expect(view.result.current.isDragging).toBe(true)
  })

  it("resets the depth on drop", async () => {
    dropped.mockResolvedValue({ files: [], directories: 0, truncated: false })
    const { view } = mount()
    act(() => view.result.current.onDragEnter(fileDrag(["Files"])))
    await act(async () => {
      view.result.current.onDrop({
        preventDefault: jest.fn(),
        dataTransfer: { types: ["Files"], files: { length: 1 }, items: { length: 1 } },
      } as never)
    })
    expect(view.result.current.isDragging).toBe(false)
  })
})

describe("smart snapshot", () => {
  it("routes the shared command to the focused composer without duplicate registration", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {})
    try {
      const first = mount()
      const second = mount()
      const shot = file("shot.png", "image/png")
      snapshot.mockResolvedValue({ files: [shot], appName: "Finder" })
      first.textarea.focus()
      await act(async () => {
        await executeCommand(SMART_SNAPSHOT_COMMAND_ID)
      })
      expect(first.add).toHaveBeenCalledWith([shot])
      expect(second.add).not.toHaveBeenCalled()
      expect(warn).not.toHaveBeenCalledWith(expect.stringContaining("already registered"))
      first.view.unmount()
      expect(getCommand(SMART_SNAPSHOT_COMMAND_ID)).toBeDefined()
      second.textarea.focus()
      await act(async () => {
        await executeCommand(SMART_SNAPSHOT_COMMAND_ID)
      })
      expect(second.add).toHaveBeenCalledWith([shot])
      second.view.unmount()
      expect(getCommand(SMART_SNAPSHOT_COMMAND_ID)).toBeUndefined()
    } finally {
      warn.mockRestore()
    }
  })

  it("is a no-op off the desktop shell", async () => {
    const { view, add } = mount({ isDesktop: false })
    await act(async () => {
      await view.result.current.captureSmartSnapshot()
    })
    expect(snapshot).not.toHaveBeenCalled()
    expect(add).not.toHaveBeenCalled()
  })

  it("stages the captured files on the desktop", async () => {
    const f = file("shot.png", "image/png")
    snapshot.mockResolvedValue({ files: [f], appName: "Finder" })
    const { view, add } = mount({ isDesktop: true })
    await act(async () => {
      await view.result.current.captureSmartSnapshot()
    })
    expect(add).toHaveBeenCalledWith([f])
    expect(view.result.current.smartSnapshotPending).toBe(false)
  })

  it("keeps the command handler current after attachment and capture state rerenders", async () => {
    const { view, textarea, add, sink } = mount()
    const command = getCommand(SMART_SNAPSHOT_COMMAND_ID)
    const shot = file("shot.png", "image/png")
    snapshot.mockResolvedValue({ files: [shot], appName: "Finder" })
    textarea.focus()
    const nextAdd = jest.fn()
    sink.add = nextAdd
    view.rerender()
    for (let index = 0; index < 2; index += 1) {
      await act(async () => {
        await executeCommand(SMART_SNAPSHOT_COMMAND_ID)
      })
      expect(getCommand(SMART_SNAPSHOT_COMMAND_ID)).toBe(command)
    }
    expect(nextAdd).toHaveBeenCalledTimes(2)
    expect(add).not.toHaveBeenCalled()
    expect(view.result.current.smartSnapshotPending).toBe(false)
  })

  it("does not start two captures before React commits pending state", async () => {
    const { view } = mount()
    snapshot.mockResolvedValue({ files: [file("shot.png", "image/png")], appName: "Finder" })
    await act(async () => {
      await Promise.all([
        view.result.current.captureSmartSnapshot(),
        view.result.current.captureSmartSnapshot(),
      ])
    })
    expect(snapshot).toHaveBeenCalledTimes(1)
  })

  it("discards an in-flight capture after its composer unmounts", async () => {
    const { view, add } = mount()
    let finish!: (value: unknown) => void
    snapshot.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve
      })
    )
    let capture!: Promise<void>
    act(() => {
      capture = view.result.current.captureSmartSnapshot()
    })
    view.unmount()
    await act(async () => {
      finish({ files: [file("shot.png", "image/png")], appName: "Finder" })
      await capture
    })
    expect(add).not.toHaveBeenCalled()
    expect(toast.success).not.toHaveBeenCalled()
  })

  it("discards a capture when the mounted composer changes conversations", async () => {
    const { view, root, add } = mount()
    root.dataset.composerSession = "old"
    let finish!: (value: unknown) => void
    snapshot.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve
      })
    )
    let capture!: Promise<void>
    act(() => {
      capture = view.result.current.captureSmartSnapshot()
    })
    root.dataset.composerSession = "new"
    await act(async () => {
      finish({ files: [file("shot.png", "image/png")], appName: "Finder" })
      await capture
    })
    expect(add).not.toHaveBeenCalled()
    expect(view.result.current.smartSnapshotPending).toBe(false)
  })

  it("does not begin a delayed capture after its composer unmounts", async () => {
    jest.useFakeTimers()
    try {
      const { view, add } = mount()
      let capture!: Promise<void>
      act(() => {
        capture = view.result.current.captureSmartSnapshot({ delayMs: 2200 })
      })
      view.unmount()
      await act(async () => {
        await jest.advanceTimersByTimeAsync(2200)
        await capture
      })
      expect(snapshot).not.toHaveBeenCalled()
      expect(add).not.toHaveBeenCalled()
    } finally {
      jest.useRealTimers()
    }
  })

  it("does not report a stale capture error after its composer unmounts", async () => {
    const { view } = mount()
    let reject!: (error: Error) => void
    snapshot.mockReturnValue(
      new Promise((_resolve, fail) => {
        reject = fail
      })
    )
    let capture!: Promise<void>
    act(() => {
      capture = view.result.current.captureSmartSnapshot()
    })
    view.unmount()
    await act(async () => {
      reject(new Error("stale capture failed"))
      await capture
    })
    expect(toast.error).not.toHaveBeenCalled()
  })
})

describe("misc intake", () => {
  it("openFileDialog clicks the hidden input", () => {
    const { view } = mount()
    const input = document.createElement("input")
    const click = jest.spyOn(input, "click")
    ;(view.result.current.fileInputRef as { current: HTMLInputElement | null }).current = input
    act(() => view.result.current.openFileDialog())
    expect(click).toHaveBeenCalled()
  })
})
