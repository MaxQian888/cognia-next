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
  },
}))
jest.mock("@cognia/logging", () => ({ loggers: { chat: { warn: jest.fn(), error: jest.fn() } } }))
jest.mock("@/lib/chat/attachments/prepare", () => ({
  COMPOSER_MAX_ATTACHMENTS: 3,
  COMPOSER_MAX_ATTACHMENT_BYTES: 1024,
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
jest.mock("@/lib/plugin/commands/registry", () => ({ registerCommand: jest.fn(() => () => {}) }))
jest.mock("@/lib/tauri/pet-window", () => ({ showMainWindow: jest.fn() }))
jest.mock("@/hooks/chat/use-remote-doc-staging", () => ({
  useRemoteDocStaging: () => async () => undefined,
}))

import { toast } from "sonner"
import { prepareComposerAttachments } from "@/lib/chat/attachments/prepare"
import { captureSmartSnapshotFiles } from "@/lib/chat/smart-snapshot"
import { collectDroppedFiles } from "@/lib/chat/drop-entries"

const prepared = prepareComposerAttachments as jest.Mock
const snapshot = captureSmartSnapshotFiles as jest.Mock
const dropped = collectDroppedFiles as jest.Mock

function file(name: string, type = "text/plain") {
  return new File(["x"], name, { type })
}

/** Mounts the hook over a controllable text buffer + attachment sink. */
function mount(opts: { isDesktop?: boolean; staged?: number; initialText?: string } = {}) {
  const add = jest.fn()
  const setInput = jest.fn()
  const setCaret = jest.fn()
  // Identity translators, but recorded — several gate messages carry the limit
  // as an ICU value, and the key alone would not prove the right number reached
  // the user.
  const tAttach = jest.fn((k: string) => k)
  const textarea = document.createElement("textarea")
  const state = { value: opts.initialText ?? "" }
  const view = renderHook(() =>
    useAttachmentIntake({
      attachments: { files: new Array(opts.staged ?? 0).fill(null), add },
      textInput: {
        get value() {
          return state.value
        },
        setInput: (next: string) => {
          state.value = next
          setInput(next)
        },
      },
      textareaRef: { current: textarea },
      setCaret,
      isDesktop: opts.isDesktop ?? true,
      t: (k) => k,
      tAttach,
    })
  )
  return { view, add, setInput, setCaret, state, textarea, tAttach }
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
  prepared.mockResolvedValue({
    files: [],
    unsupportedCount: 0,
    tooLargeCount: 0,
    optimizedCount: 0,
  })
})

describe("acceptFiles — the single gate", () => {
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

  it("removeLink strips the URL from the draft", () => {
    const { view, state } = mount({ initialText: "see https://example.com/docs now" })
    act(() => view.result.current.removeLink("https://example.com/docs"))
    expect(state.value).not.toContain("https://example.com/docs")
  })
})
