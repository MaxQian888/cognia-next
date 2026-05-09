/**
 * @jest-environment jsdom
 */
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { ComposerPlusMenu } from "./composer-plus-menu"

// Jest 30 + TS strict: jest.fn() with an explicit impl widens its type
// so any call signature is accepted. The `(...args: unknown[])` shape lets
// us keep the mock untyped at the call site without juggling generics.
const pickPhotoMock = jest.fn(async (..._args: unknown[]): Promise<unknown> => undefined)
const pickMultipleMock = jest.fn(async (..._args: unknown[]): Promise<unknown> => undefined)
jest.mock("@/lib/capacitor/camera", () => ({
  pickPhoto: (opts: unknown) => pickPhotoMock(opts),
  pickMultiplePhotos: (opts: unknown) => pickMultipleMock(opts),
}))
const showToastMock = jest.fn(async (..._args: unknown[]) => ({ kind: "ok" as const }))
jest.mock("@/lib/capacitor/toast", () => ({
  showToast: (opts: unknown) => showToastMock(opts),
}))
const selectionFeedbackMock = jest.fn(async () => ({ kind: "ok" as const }))
jest.mock("@/lib/capacitor/haptics", () => ({
  selectionFeedback: () => selectionFeedbackMock(),
}))
jest.mock("@/lib/capacitor/_shared", () => ({
  makeDefaultLoader: () => async () => {
    throw new Error("voice-recorder unavailable in tests")
  },
  withPlugin: async (loader: unknown, _action?: unknown) => {
    try {
      const fn = loader as () => Promise<unknown>
      await fn()
      return { kind: "ok" }
    } catch {
      return { kind: "unsupported" }
    }
  },
}))

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => {
    const map: Record<string, string> = {
      toggleAria: "Attachments",
      camera: "Camera",
      album: "Album",
      file: "File",
      voice: "Voice",
      voiceStop: "Stop recording",
      voiceCannotStart: "Cannot start recording",
      voiceStopFailed: "Failed to stop recording.",
      unsupported: "Unsupported.",
      permissionDeniedCamera: "Camera permission required.",
      permissionDeniedMic: "Mic permission required.",
    }
    return map[key] ?? key
  },
}))

beforeEach(() => {
  pickPhotoMock.mockReset()
  pickMultipleMock.mockReset()
  showToastMock.mockReset().mockResolvedValue({ kind: "ok" })
  selectionFeedbackMock.mockReset().mockResolvedValue({ kind: "ok" })
})

describe("<ComposerPlusMenu />", () => {
  it("toggles open / closed", async () => {
    const user = userEvent.setup()
    render(<ComposerPlusMenu onAttach={jest.fn()} />)
    await user.click(screen.getByTestId("composer-plus-toggle"))
    expect(screen.getByTestId("composer-plus-menu")).toBeInTheDocument()
    await user.click(screen.getByTestId("composer-plus-toggle"))
    expect(screen.queryByTestId("composer-plus-menu")).not.toBeInTheDocument()
  })

  it("forwards a captured photo to onAttach", async () => {
    pickPhotoMock.mockResolvedValue({
      kind: "captured",
      base64: "AAAA",
      uri: "blob:1",
      format: "jpeg",
    })
    const onAttach = jest.fn()
    const user = userEvent.setup()
    render(<ComposerPlusMenu onAttach={onAttach} />)
    await user.click(screen.getByTestId("composer-plus-toggle"))
    await user.click(screen.getByTestId("composer-plus-camera"))
    await waitFor(() =>
      expect(onAttach).toHaveBeenCalledWith({
        kind: "photo",
        base64: "AAAA",
        uri: "blob:1",
        mime: "image/jpeg",
      })
    )
  })

  it("reports permission errors via onError", async () => {
    pickPhotoMock.mockResolvedValue({ kind: "permission_denied" })
    const onError = jest.fn()
    const user = userEvent.setup()
    render(<ComposerPlusMenu onAttach={jest.fn()} onError={onError} />)
    await user.click(screen.getByTestId("composer-plus-toggle"))
    await user.click(screen.getByTestId("composer-plus-camera"))
    await waitFor(() =>
      expect(onError).toHaveBeenCalledWith("permission", "Camera permission required.")
    )
  })

  it("forwards picked photos array via onAttach", async () => {
    pickMultipleMock.mockResolvedValue({
      kind: "picked",
      photos: [{ uri: "blob:1", format: "jpeg" }],
    })
    const onAttach = jest.fn()
    const user = userEvent.setup()
    render(<ComposerPlusMenu onAttach={onAttach} />)
    await user.click(screen.getByTestId("composer-plus-toggle"))
    await user.click(screen.getByTestId("composer-plus-album"))
    await waitFor(() =>
      expect(onAttach).toHaveBeenCalledWith({
        kind: "photos",
        items: [{ uri: "blob:1", mime: "image/jpeg" }],
      })
    )
  })

  it("forwards a chosen file via the file input change", async () => {
    const onAttach = jest.fn()
    const user = userEvent.setup()
    render(<ComposerPlusMenu onAttach={onAttach} />)
    await user.click(screen.getByTestId("composer-plus-toggle"))
    const input = screen.getByTestId("composer-plus-file-input") as HTMLInputElement
    const file = new File(["payload"], "doc.txt", { type: "text/plain" })
    await user.upload(input, file)
    expect(onAttach).toHaveBeenCalledWith({ kind: "file", file })
  })

  it("voice button reports unsupported on web (no native plugin)", async () => {
    const onError = jest.fn()
    const user = userEvent.setup()
    render(<ComposerPlusMenu onAttach={jest.fn()} onError={onError} />)
    await user.click(screen.getByTestId("composer-plus-toggle"))
    await user.click(screen.getByTestId("composer-plus-voice"))
    await waitFor(() => expect(onError).toHaveBeenCalledWith("unsupported", "Unsupported."))
  })

  it("ignores cancellation outcomes silently", async () => {
    pickPhotoMock.mockResolvedValue({ kind: "cancelled" })
    const onAttach = jest.fn()
    const onError = jest.fn()
    const user = userEvent.setup()
    render(<ComposerPlusMenu onAttach={onAttach} onError={onError} />)
    await user.click(screen.getByTestId("composer-plus-toggle"))
    await user.click(screen.getByTestId("composer-plus-camera"))
    await new Promise((r) => setTimeout(r, 0))
    expect(onAttach).not.toHaveBeenCalled()
    expect(onError).not.toHaveBeenCalled()
  })

  // ── onSend (Mobile completeness Phase 2.5 — base64 SendContent path) ─────

  it("camera also forwards a SendContent image block via onSend", async () => {
    pickPhotoMock.mockResolvedValue({
      kind: "captured",
      base64: "AAAA",
      uri: "blob:1",
      format: "jpeg",
    })
    const onSend = jest.fn(async () => {})
    const user = userEvent.setup()
    render(<ComposerPlusMenu onAttach={jest.fn()} onSend={onSend} />)
    await user.click(screen.getByTestId("composer-plus-toggle"))
    await user.click(screen.getByTestId("composer-plus-camera"))
    await waitFor(() =>
      expect(onSend).toHaveBeenCalledWith([
        {
          type: "image",
          source: { type: "base64", media_type: "image/jpeg", data: "AAAA" },
        },
      ])
    )
  })

  it("file input forwards an image file as a SendContent block via onSend", async () => {
    const onSend = jest.fn(async () => {})
    const user = userEvent.setup()
    render(<ComposerPlusMenu onAttach={jest.fn()} onSend={onSend} />)
    await user.click(screen.getByTestId("composer-plus-toggle"))
    const input = screen.getByTestId("composer-plus-file-input") as HTMLInputElement
    const file = new File([new Uint8Array([1, 2, 3])], "pic.png", { type: "image/png" })
    await user.upload(input, file)
    await waitFor(() => expect(onSend).toHaveBeenCalled())
    type ImageBlock = {
      type: string
      source?: { type: string; media_type: string; data: string }
    }
    const firstArg = (onSend.mock.calls[0] as unknown as [ImageBlock[]] | undefined)?.[0]
    const block = firstArg?.[0]
    expect(block?.type).toBe("image")
    expect(block?.source?.media_type).toBe("image/png")
    expect(typeof block?.source?.data).toBe("string")
  })

  it("file input does NOT call onSend for non-image files", async () => {
    const onSend = jest.fn(async () => {})
    const user = userEvent.setup()
    render(<ComposerPlusMenu onAttach={jest.fn()} onSend={onSend} />)
    await user.click(screen.getByTestId("composer-plus-toggle"))
    const input = screen.getByTestId("composer-plus-file-input") as HTMLInputElement
    const file = new File(["doc"], "doc.txt", { type: "text/plain" })
    await user.upload(input, file)
    await new Promise((r) => setTimeout(r, 0))
    expect(onSend).not.toHaveBeenCalled()
  })

  it("camera path with no base64 skips onSend (URI-only response)", async () => {
    pickPhotoMock.mockResolvedValue({
      kind: "captured",
      base64: undefined,
      uri: "blob:9",
      format: "jpeg",
    })
    const onSend = jest.fn(async () => {})
    const user = userEvent.setup()
    render(<ComposerPlusMenu onAttach={jest.fn()} onSend={onSend} />)
    await user.click(screen.getByTestId("composer-plus-toggle"))
    await user.click(screen.getByTestId("composer-plus-camera"))
    await new Promise((r) => setTimeout(r, 0))
    expect(onSend).not.toHaveBeenCalled()
  })
})
