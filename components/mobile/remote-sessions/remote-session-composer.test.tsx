/** @jest-environment jsdom */
import "fake-indexeddb/auto"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import {
  RemoteSessionComposer,
  type RemoteSessionComposerProps,
} from "./remote-session-composer"

/**
 * The composer reads the NEGOTIATED runtime snapshot, which is what the
 * companion shell populates — not `stores/remote-host`, which is the desktop's
 * own registry and is always empty on a phone.
 */
const HOST_WITH_UPLOADS = {
  compatible: true,
  operations: ["session_attachment_upload_init"],
  grants: [],
  limits: {
    attachmentAcceptTypes: ["image/*", ".pdf"],
    attachmentMaxPerMessage: 2,
    attachmentMaxBytes: 1024,
  },
}
const runtimeSnapshotMock = jest.fn((): unknown => ({
  target: null,
  vaultState: "unlocked",
  connectionState: "online",
  host: HOST_WITH_UPLOADS,
}))
jest.mock("@/hooks/use-runtime-snapshot", () => ({
  useRuntimeSnapshot: () => runtimeSnapshotMock(),
}))

const prepareMock = jest.fn()
jest.mock("@/lib/chat/attachments/prepare", () => ({
  ...jest.requireActual("@/lib/chat/attachments/prepare"),
  prepareComposerAttachments: (...args: unknown[]) => prepareMock(...args),
}))

const abortUploadMock = jest.fn(async (_uploadId: string) => {})
jest.mock("@/lib/companion/attachment-upload-client", () => ({
  abortSessionAttachmentUpload: (uploadId: string) => abortUploadMock(uploadId),
}))

const toastWarning = jest.fn()
jest.mock("sonner", () => ({ toast: { warning: (...args: unknown[]) => toastWarning(...args) } }))

function pngFile(name = "shot.png", size = 32): File {
  const file = new File([new Uint8Array(size)], name, { type: "image/png" })
  // jsdom's File has no `arrayBuffer` in every version the suite runs on.
  Object.defineProperty(file, "arrayBuffer", {
    value: async () => new ArrayBuffer(size),
    configurable: true,
  })
  return file
}

function setup(overrides: Partial<Parameters<typeof RemoteSessionComposer>[0]> = {}) {
  const onSend = jest.fn(async () => {})
  const onInterrupt = jest.fn()
  const props = {
    sessionId: "ses-1",
    streaming: false,
    offline: false,
    onSend,
    onInterrupt,
    ...overrides,
  }
  render(<RemoteSessionComposer {...props} />)
  return { onSend, onInterrupt }
}

beforeEach(() => {
  runtimeSnapshotMock.mockReturnValue({
    target: null,
    vaultState: "unlocked",
    connectionState: "online",
    host: HOST_WITH_UPLOADS,
  })
  prepareMock.mockImplementation(async (files: readonly File[]) => ({
    files: [...files],
    unsupportedCount: 0,
    tooLargeCount: 0,
    optimizedCount: 0,
  }))
  toastWarning.mockClear()
  abortUploadMock.mockClear()
  window.localStorage.clear()
})

describe("RemoteSessionComposer", () => {
  it("sends the text and clears only after the send resolves", async () => {
    const user = userEvent.setup()
    const { onSend } = setup()

    await user.type(screen.getByTestId("remote-composer-input"), "look at this")
    await user.click(screen.getByTestId("remote-send"))

    expect(onSend).toHaveBeenCalledWith("look at this", [], expect.any(Object))
    await waitFor(() =>
      expect(screen.getByTestId("remote-composer-input")).toHaveValue("")
    )
  })

  it("keeps the text and the files when the send fails", async () => {
    const user = userEvent.setup()
    const onSend = jest.fn(async () => {
      throw new Error("host_state_not_controller")
    })
    render(
      <RemoteSessionComposer
        sessionId="ses-1"
        streaming={false}
        offline={false}
        onSend={onSend}
        onInterrupt={jest.fn()}
      />
    )

    await user.upload(screen.getByTestId("remote-attach-input"), pngFile())
    await user.type(screen.getByTestId("remote-composer-input"), "with a screenshot")
    await user.click(screen.getByTestId("remote-send"))

    await waitFor(() => expect(onSend).toHaveBeenCalled())
    expect(screen.getByTestId("remote-composer-input")).toHaveValue("with a screenshot")
    expect(screen.getByTestId("remote-staged-attachments")).toBeInTheDocument()
  })

  it("uploads the staged bytes alongside the text", async () => {
    const user = userEvent.setup()
    const { onSend } = setup()

    await user.upload(screen.getByTestId("remote-attach-input"), pngFile("diagram.png", 8))
    await user.click(screen.getByTestId("remote-send"))

    await waitFor(() => expect(onSend).toHaveBeenCalled())
    const [text, attachments] = (onSend as jest.Mock).mock.calls[0]!
    expect(text).toBe("")
    // The hash is computed once, at staging time — it is the Host's dedupe key,
    // and paying for it here is what makes a resume cost one round trip.
    expect(attachments).toEqual([
      {
        name: "diagram.png",
        mediaType: "image/png",
        bytes: expect.any(Uint8Array),
        hash: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
    ])
  })

  it("sends a file with no caption at all", async () => {
    const user = userEvent.setup()
    const { onSend } = setup()

    await user.click(screen.getByTestId("remote-send"))
    expect(onSend).not.toHaveBeenCalled()

    await user.upload(screen.getByTestId("remote-attach-input"), pngFile())
    await user.click(screen.getByTestId("remote-send"))
    await waitFor(() => expect(onSend).toHaveBeenCalled())
  })

  it("restores the draft text and its staged files after a restart", async () => {
    const { setDraft, clearDraft } = await import("@/lib/db/chat-drafts")
    await setDraft("ses-restore", "half typed", [
      {
        name: "kept.png",
        mediaType: "image/png",
        size: 4,
        bytes: Uint8Array.from([1, 2, 3, 4]),
        hash: "c".repeat(64),
        uploadId: "upl_prev",
        uploadedBytes: 2,
      },
    ])

    const onSend = jest.fn(async () => {})
    render(
      <RemoteSessionComposer
        sessionId="ses-restore"
        streaming={false}
        offline={false}
        onSend={onSend}
        onInterrupt={jest.fn()}
      />
    )

    await waitFor(() =>
      expect(screen.getByTestId("remote-composer-input")).toHaveValue("half typed")
    )
    expect(screen.getByTestId("remote-staged-attachments")).toBeInTheDocument()

    // The restored file rejoins its upload rather than being re-hashed and
    // re-sent: the hash it was staged with travels with it.
    await userEvent.setup().click(screen.getByTestId("remote-send"))
    await waitFor(() => expect(onSend).toHaveBeenCalled())
    expect((onSend as jest.Mock).mock.calls[0]![1]).toEqual([
      {
        name: "kept.png",
        mediaType: "image/png",
        bytes: expect.any(Uint8Array),
        hash: "c".repeat(64),
      },
    ])
    await clearDraft("ses-restore")
  })

  it("clears the draft once the host has the message", async () => {
    const user = userEvent.setup()
    const { getDraft } = await import("@/lib/db/chat-drafts")
    setup({ sessionId: "ses-clear" })

    await user.type(screen.getByTestId("remote-composer-input"), "sent")
    await waitFor(async () => expect((await getDraft("ses-clear"))?.text).toBe("sent"))

    await user.click(screen.getByTestId("remote-send"))
    await waitFor(async () => expect(await getDraft("ses-clear")).toBeNull())
  })

  it("hides the paperclip entirely on a host that cannot receive attachments", () => {
    runtimeSnapshotMock.mockReturnValue({
      target: null,
      vaultState: "unlocked",
      connectionState: "online",
      host: { compatible: true, operations: ["host_state_submit"], grants: [] },
    })
    setup()
    expect(screen.queryByTestId("remote-attach")).not.toBeInTheDocument()
    expect(screen.getByTestId("remote-composer-input")).toBeInTheDocument()
  })

  it("hides it on an incompatible host, and on one that reported nothing", () => {
    for (const host of [
      { compatible: false, operations: ["session_attachment_upload_init"], grants: [] },
      undefined,
    ]) {
      runtimeSnapshotMock.mockReturnValue({
        target: null,
        vaultState: "unlocked",
        connectionState: "online",
        host,
      })
      const view = render(
        <RemoteSessionComposer
          sessionId="ses-gate"
          streaming={false}
          offline={false}
          onSend={jest.fn(async () => {})}
          onInterrupt={jest.fn()}
        />
      )
      expect(screen.queryByTestId("remote-attach")).not.toBeInTheDocument()
      view.unmount()
    }
  })

  it("tells the host to drop the staging slot when a staged file is removed", async () => {
    const user = userEvent.setup()
    const gate: { release?: () => void } = {}
    const onSend: RemoteSessionComposerProps["onSend"] = jest.fn(
      async (_text, _attachments, options) => {
        options?.onUploadProgress?.(0, { uploadedBytes: 2, totalBytes: 8, uploadId: "upl_live" })
        await new Promise<void>((resolve) => {
          gate.release = resolve
        })
        throw new Error("send failed")
      }
    )
    render(
      <RemoteSessionComposer
        sessionId="ses-abort"
        streaming={false}
        offline={false}
        onSend={onSend}
        onInterrupt={jest.fn()}
      />
    )

    await user.upload(screen.getByTestId("remote-attach-input"), pngFile("drop.png", 8))
    await user.click(screen.getByTestId("remote-send"))
    await screen.findByTestId("remote-attachment-progress")
    gate.release?.()
    await waitFor(() => expect(screen.queryByTestId("remote-attachment-remove")).toBeInTheDocument())

    await user.click(screen.getByTestId("remote-attachment-remove"))
    // The slot is bounded per (session, device); a removed file that kept it
    // would cost the user one of their six places for the next 30 minutes.
    await waitFor(() => expect(abortUploadMock).toHaveBeenCalledWith("upl_live"))
  })

  it("holds the count ceiling the host published, not a local guess", async () => {
    const user = userEvent.setup()
    setup()

    await user.upload(screen.getByTestId("remote-attach-input"), [
      pngFile("a.png"),
      pngFile("b.png"),
      pngFile("c.png"),
    ])

    await waitFor(() => expect(toastWarning).toHaveBeenCalled())
    // Two staged, the third refused — the manifest said two.
    expect(screen.getAllByTestId("remote-attachment-chip")).toHaveLength(2)
  })

  it("passes the host's per-file size ceiling to the shared staging gate", async () => {
    const user = userEvent.setup()
    setup()
    await user.upload(screen.getByTestId("remote-attach-input"), pngFile())
    expect(prepareMock).toHaveBeenCalledWith(expect.any(Array), { maxFileSize: 1024 })
  })

  it("says which files were skipped rather than dropping them silently", async () => {
    const user = userEvent.setup()
    prepareMock.mockResolvedValue({
      files: [],
      unsupportedCount: 1,
      tooLargeCount: 1,
      optimizedCount: 0,
    })
    setup()

    await user.upload(screen.getByTestId("remote-attach-input"), pngFile("thing.png"))
    await waitFor(() => expect(toastWarning).toHaveBeenCalledTimes(2))
    expect(screen.queryByTestId("remote-staged-attachments")).not.toBeInTheDocument()
  })

  it("removes a staged file before it is sent", async () => {
    const user = userEvent.setup()
    setup()

    await user.upload(screen.getByTestId("remote-attach-input"), pngFile())
    expect(screen.getByTestId("remote-staged-attachments")).toBeInTheDocument()

    await user.click(screen.getByTestId("remote-attachment-remove"))
    expect(screen.queryByTestId("remote-staged-attachments")).not.toBeInTheDocument()
  })

  it("swaps send for interrupt while the host turn is producing", async () => {
    const user = userEvent.setup()
    const { onInterrupt } = setup({ streaming: true })

    expect(screen.queryByTestId("remote-send")).not.toBeInTheDocument()
    await user.click(screen.getByTestId("remote-interrupt"))
    expect(onInterrupt).toHaveBeenCalled()
  })

  it("blocks sending while the transport is down and says why", async () => {
    const user = userEvent.setup()
    const { onSend } = setup({ offline: true })

    expect(screen.getByTestId("remote-offline-hint")).toBeInTheDocument()
    expect(screen.getByTestId("remote-send")).toBeDisabled()
    await user.type(screen.getByTestId("remote-composer-input"), "queued?{Enter}")
    expect(onSend).not.toHaveBeenCalled()
  })

  it("reports upload progress against the file it belongs to", async () => {
    const user = userEvent.setup()
    const gate: { release?: () => void } = {}
    const onSend: RemoteSessionComposerProps["onSend"] = jest.fn(
      async (_text, _attachments, options) => {
        options?.onUploadProgress?.(0, { uploadedBytes: 4, totalBytes: 8, uploadId: "upl_1" })
        await new Promise<void>((resolve) => {
          gate.release = resolve
        })
      }
    )
    render(
      <RemoteSessionComposer
        sessionId="ses-1"
        streaming={false}
        offline={false}
        onSend={onSend}
        onInterrupt={jest.fn()}
      />
    )

    await user.upload(screen.getByTestId("remote-attach-input"), pngFile("half.png", 8))
    await user.click(screen.getByTestId("remote-send"))

    const bar = await screen.findByTestId("remote-attachment-progress")
    expect(bar).toHaveAttribute("aria-valuenow", "50")
    gate.release?.()
  })
})
