/**
 * @jest-environment jsdom
 */
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { ComposerPlusMenu } from "./composer-plus-menu"
import { useChatStore } from "@/stores/chat"

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
// vaul drives its drag from real pointer events and reads transforms out of
// `getComputedStyle`, which jsdom does not provide — a `userEvent` click on
// anything inside the sheet dies in vaul's own `onPointerUp`. Flatten the
// primitives: the sheet mechanics belong to `components/ui/drawer`, this suite
// is about what the menu offers. (Same pattern as attach-menu.test.tsx's
// Popover mock.) `onCloseAutoFocus` is dropped rather than spread — it is not a
// DOM attribute.
// Controllable registry reads. Both are module-level maps seeded by their own
// module load, so `requireActual` + a spy on the one function keeps every other
// consumer in the graph untouched.
const availableDocsMock = jest.fn((): unknown[] => [])
jest.mock("@/lib/docs-providers/registry", () => ({
  ...jest.requireActual<typeof import("@/lib/docs-providers/registry")>(
    "@/lib/docs-providers/registry"
  ),
  listAvailableDocsProviders: () => availableDocsMock(),
}))
const chatCapabilitiesMock = jest.fn((): unknown[] => [])
jest.mock("@/lib/external-services/catalog", () => ({
  ...jest.requireActual<typeof import("@/lib/external-services/catalog")>(
    "@/lib/external-services/catalog"
  ),
  listExternalCapabilities: () => chatCapabilitiesMock(),
}))

jest.mock("@/components/ui/drawer", () => ({
  Drawer: ({ open, children }: { open?: boolean; children: React.ReactNode }) =>
    open ? <>{children}</> : null,
  DrawerContent: ({
    children,
    onCloseAutoFocus: _onCloseAutoFocus,
    ...rest
  }: {
    children: React.ReactNode
    onCloseAutoFocus?: (e: Event) => void
  } & React.HTMLAttributes<HTMLDivElement>) => <div {...rest}>{children}</div>,
  DrawerHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DrawerTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  DrawerDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
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
      sheetDescription: "Sheet description",
      // Shared with the desktop menu (`chat.composer.attachMenu`). The mock is
      // namespace-agnostic, so one flat map covers both `useTranslations` calls.
      attachGroup: "Attach",
      turnGroup: "This turn",
      extendGroup: "Extend",
      cloudDocs: "Cloud document",
      records: "Reference a record",
      planMode: "Plan mode",
      goal: "Set a goal",
      slashCommands: "Slash commands",
      externalServices: "External services",
      issue: "Issue",
    }
    return map[key] ?? key
  },
}))

beforeEach(() => {
  pickPhotoMock.mockReset()
  pickMultipleMock.mockReset()
  showToastMock.mockReset().mockResolvedValue({ kind: "ok" })
  selectionFeedbackMock.mockReset().mockResolvedValue({ kind: "ok" })
  availableDocsMock.mockReset().mockReturnValue([])
  chatCapabilitiesMock.mockReset().mockReturnValue([])
  useChatStore.getState().setPermissionMode(null)
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

  it("forwards a single chosen file via the file input change", async () => {
    const onAttach = jest.fn()
    const user = userEvent.setup()
    render(<ComposerPlusMenu onAttach={onAttach} />)
    await user.click(screen.getByTestId("composer-plus-toggle"))
    const input = screen.getByTestId("composer-plus-file-input") as HTMLInputElement
    const file = new File(["payload"], "doc.txt", { type: "text/plain" })
    await user.upload(input, file)
    expect(onAttach).toHaveBeenCalledWith({ kind: "files", files: [file] })
  })

  it("forwards multiple chosen files via the file input change", async () => {
    const onAttach = jest.fn()
    const user = userEvent.setup()
    render(<ComposerPlusMenu onAttach={onAttach} />)
    await user.click(screen.getByTestId("composer-plus-toggle"))
    const input = screen.getByTestId("composer-plus-file-input") as HTMLInputElement
    const a = new File(["a"], "a.txt", { type: "text/plain" })
    const b = new File(["b"], "b.txt", { type: "text/plain" })
    await user.upload(input, [a, b])
    expect(onAttach).toHaveBeenCalledWith({ kind: "files", files: [a, b] })
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

  it("forwards multiple image files as multiple SendContent blocks in one onSend", async () => {
    const onSend = jest.fn(async () => {})
    const user = userEvent.setup()
    render(<ComposerPlusMenu onAttach={jest.fn()} onSend={onSend} />)
    await user.click(screen.getByTestId("composer-plus-toggle"))
    const input = screen.getByTestId("composer-plus-file-input") as HTMLInputElement
    const a = new File([new Uint8Array([1])], "a.png", { type: "image/png" })
    const b = new File([new Uint8Array([2])], "b.jpg", { type: "image/jpeg" })
    await user.upload(input, [a, b])
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1))
    const blocks = (onSend.mock.calls[0] as unknown as [unknown[]])[0]
    expect(blocks).toHaveLength(2)
  })

  it("for a mixed selection forwards all files but only sends image blocks", async () => {
    const onAttach = jest.fn()
    const onSend = jest.fn(async () => {})
    const user = userEvent.setup()
    render(<ComposerPlusMenu onAttach={onAttach} onSend={onSend} />)
    await user.click(screen.getByTestId("composer-plus-toggle"))
    const input = screen.getByTestId("composer-plus-file-input") as HTMLInputElement
    const png = new File([new Uint8Array([1])], "p.png", { type: "image/png" })
    const txt = new File(["t"], "t.txt", { type: "text/plain" })
    await user.upload(input, [png, txt])
    await waitFor(() => expect(onSend).toHaveBeenCalledTimes(1))
    expect(onAttach).toHaveBeenCalledWith({ kind: "files", files: [png, txt] })
    const blocks = (onSend.mock.calls[0] as unknown as [unknown[]])[0]
    expect(blocks).toHaveLength(1)
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

  it("hides the voice branch when showVoice is false and applies fileAccept", async () => {
    const user = userEvent.setup()
    render(
      <ComposerPlusMenu
        onAttach={jest.fn()}
        showVoice={false}
        fileAccept="image/*,.pdf"
        capabilities={<div data-testid="mobile-composer-capabilities">Capabilities</div>}
      />
    )
    await user.click(screen.getByTestId("composer-plus-toggle"))
    expect(screen.queryByTestId("composer-plus-voice")).not.toBeInTheDocument()
    expect(screen.queryByTestId("composer-plus-voice-stop")).not.toBeInTheDocument()
    expect(screen.getByTestId("mobile-composer-capabilities")).toBeInTheDocument()
    const input = screen.getByTestId("composer-plus-file-input") as HTMLInputElement
    expect(input.accept).toBe("image/*,.pdf")
  })
})

describe("<ComposerPlusMenu /> groups", () => {
  async function openMenu(props: Partial<React.ComponentProps<typeof ComposerPlusMenu>> = {}) {
    const user = userEvent.setup()
    render(<ComposerPlusMenu onAttach={jest.fn()} showVoice={false} {...props} />)
    await user.click(screen.getByTestId("composer-plus-toggle"))
    return user
  }

  it("groups the sheet into attach / this turn / extend", async () => {
    await openMenu({ onInsert: jest.fn() })
    expect(screen.getByText("Attach")).toBeInTheDocument()
    expect(screen.getByText("This turn")).toBeInTheDocument()
    expect(screen.getByText("Extend")).toBeInTheDocument()
  })

  it("hides every typing entry when onInsert is absent", async () => {
    await openMenu()
    expect(screen.queryByTestId("composer-plus-records")).not.toBeInTheDocument()
    expect(screen.queryByTestId("composer-plus-goal")).not.toBeInTheDocument()
    expect(screen.queryByTestId("composer-plus-slash")).not.toBeInTheDocument()
    // Plan mode writes the store directly, so it survives without a way to type.
    expect(screen.getByTestId("composer-plus-plan-mode")).toBeInTheDocument()
  })

  it("hides cloud documents on a host with no available provider", async () => {
    await openMenu({ onInsert: jest.fn() })
    expect(availableDocsMock).toHaveBeenCalled()
    expect(screen.queryByTestId("composer-plus-cloud-docs")).not.toBeInTheDocument()
  })

  it("drills into cloud documents and types the provider prefix", async () => {
    availableDocsMock.mockReturnValue([{ id: "lark", mentionPrefix: "lark:" }])
    const onInsert = jest.fn()
    const user = await openMenu({ onInsert })
    await user.click(screen.getByTestId("composer-plus-cloud-docs"))
    await user.click(screen.getByTestId("composer-plus-docs-lark"))
    expect(onInsert).toHaveBeenCalledWith("@lark:")
    // ...and the sheet closed behind it, so the panel it opened is visible.
    expect(screen.queryByTestId("composer-plus-menu")).not.toBeInTheDocument()
  })

  it("drills into records, goes back, then types an entity prefix", async () => {
    const onInsert = jest.fn()
    const user = await openMenu({ onInsert })
    await user.click(screen.getByTestId("composer-plus-records"))
    expect(screen.getByTestId("composer-plus-record-issue")).toBeInTheDocument()
    // The grid is gone while drilled in — one panel at a time.
    expect(screen.queryByTestId("composer-plus-camera")).not.toBeInTheDocument()
    await user.click(screen.getByTestId("composer-plus-back"))
    expect(screen.getByTestId("composer-plus-camera")).toBeInTheDocument()
    await user.click(screen.getByTestId("composer-plus-records"))
    await user.click(screen.getByTestId("composer-plus-record-issue"))
    expect(onInsert).toHaveBeenCalledWith("@issue:")
  })

  it("reopens on the root panel after drilling in and closing", async () => {
    const user = await openMenu({ onInsert: jest.fn() })
    await user.click(screen.getByTestId("composer-plus-records"))
    await user.click(screen.getByTestId("composer-plus-toggle"))
    await user.click(screen.getByTestId("composer-plus-toggle"))
    expect(screen.getByTestId("composer-plus-camera")).toBeInTheDocument()
  })

  it("toggles the session permission mode from the plan-mode row", async () => {
    const user = await openMenu()
    await user.click(screen.getByTestId("composer-plus-plan-mode"))
    expect(useChatStore.getState().permissionMode).toBe("plan")
  })

  it("types the goal and slash prefixes", async () => {
    const onInsert = jest.fn()
    const user = await openMenu({ onInsert })
    await user.click(screen.getByTestId("composer-plus-goal"))
    expect(onInsert).toHaveBeenCalledWith("/goal ")
    await user.click(screen.getByTestId("composer-plus-toggle"))
    await user.click(screen.getByTestId("composer-plus-slash"))
    expect(onInsert).toHaveBeenCalledWith("/")
  })

  it("shows the external-services row only with a handler AND a reachable capability", async () => {
    chatCapabilitiesMock.mockReturnValue([{ capabilityId: "a" }])
    await openMenu()
    expect(screen.queryByTestId("composer-plus-services")).not.toBeInTheDocument()
  })

  it("routes the external-services row to settings", async () => {
    chatCapabilitiesMock.mockReturnValue([{ capabilityId: "a" }, { capabilityId: "b" }])
    const onOpenExternalServices = jest.fn()
    const user = await openMenu({ onOpenExternalServices })
    await user.click(screen.getByTestId("composer-plus-services"))
    expect(onOpenExternalServices).toHaveBeenCalled()
    expect(screen.queryByTestId("composer-plus-menu")).not.toBeInTheDocument()
  })
})
