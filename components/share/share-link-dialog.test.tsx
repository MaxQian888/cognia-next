import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { ShareLinkDialog } from "./share-link-dialog"
import type { SharePayload } from "@/lib/share/types"

const mockCreate = jest.fn()
const mockRevoke = jest.fn()

jest.mock("@/lib/share/client", () => {
  class ShareNotConfiguredError extends Error {
    constructor() {
      super("not configured")
      this.name = "ShareNotConfiguredError"
    }
  }
  class SharePayloadTooLargeError extends Error {}
  class ShareRequestError extends Error {
    constructor(readonly status: number) {
      super(`HTTP ${status}`)
    }
  }
  class ShareFilesTooLargeError extends Error {}
  class ShareFilesUploadError extends Error {
    constructor(
      readonly revoked: boolean,
      readonly cause: unknown
    ) {
      super("upload failed")
    }
  }
  return {
    createShareLink: (...a: unknown[]) => mockCreate(...a),
    revokeShareLink: (...a: unknown[]) => mockRevoke(...a),
    ShareNotConfiguredError,
    SharePayloadTooLargeError,
    ShareRequestError,
    ShareFilesTooLargeError,
    ShareFilesUploadError,
  }
})

const mockSelection = jest.fn()
jest.mock("@/hooks/share/use-share-file-selection", () => ({
  useShareFileSelection: (...a: unknown[]) => mockSelection(...a),
}))
const mockPolicy = jest.fn()
jest.mock("@/lib/filespace/policy", () => ({
  ...jest.requireActual("@/lib/filespace/policy"),
  loadEffectiveFileSharingPolicy: (...a: unknown[]) => mockPolicy(...a),
}))
const mockAuthorize = jest.fn()
jest.mock("@/lib/collab/shared-session-access", () => ({
  ...jest.requireActual("@/lib/collab/shared-session-access"),
  assertSharedSessionFileShare: (...a: unknown[]) => mockAuthorize(...a),
}))

import {
  ShareFilesUploadError,
  ShareNotConfiguredError,
  SharePayloadTooLargeError,
  ShareRequestError,
} from "@/lib/share/client"
import { ShareFileChangedError } from "@/lib/share/blobs"
import { DEFAULT_FILE_SHARING_POLICY } from "@/lib/filespace/policy"
import type { FileSpacePath } from "@/types/filespace"

const PAYLOAD: SharePayload = {
  kind: "chat-html",
  mime: "text/html",
  data: "<p/>",
  encoding: "utf8",
  title: "T",
}
const buildPayload = () => PAYLOAD

const NO_SELECTION = {
  loaded: undefined,
  expanded: { files: [], skippedSensitive: 0, truncated: false, issues: [] },
  pending: false,
  failed: false,
}

beforeEach(() => {
  jest.clearAllMocks()
  mockSelection.mockReturnValue(NO_SELECTION)
  mockPolicy.mockResolvedValue({
    policy: DEFAULT_FILE_SHARING_POLICY,
    local: DEFAULT_FILE_SHARING_POLICY,
  })
  mockAuthorize.mockResolvedValue(null)
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: jest.fn().mockResolvedValue(undefined) },
  })
})

function open(props: Partial<React.ComponentProps<typeof ShareLinkDialog>> = {}) {
  return render(
    <ShareLinkDialog buildPayload={buildPayload} open onOpenChange={() => {}} {...props} />
  )
}

describe("ShareLinkDialog", () => {
  it("renders the lifecycle form", () => {
    open()
    expect(screen.getByText("Share via link")).toBeInTheDocument()
    expect(screen.getByText("Expires")).toBeInTheDocument()
    expect(screen.getByText("View limit")).toBeInTheDocument()
  })

  it("renders an artifact summary inside the pre-publish form", () => {
    open({ artifactSummary: <div>Alpha and Bravo</div> })

    expect(screen.getByText("Alpha and Bravo")).toBeInTheDocument()
  })

  it("creates a link with the default lifecycle and shows the url + qr", async () => {
    mockCreate.mockResolvedValue({
      code: "AbC",
      url: "https://share.test/v/AbC#k=KEY",
      expiresAt: 1,
    })
    open()
    fireEvent.click(screen.getByRole("button", { name: "Create link" }))

    await waitFor(() => expect(screen.getByText("Your share link is ready")).toBeInTheDocument())
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: PAYLOAD,
        ttlSeconds: 604_800,
        maxViews: undefined,
        burnAfterRead: false,
        files: [],
      }),
      undefined
    )
    expect(screen.getByDisplayValue("https://share.test/v/AbC#k=KEY")).toBeInTheDocument()
  })

  it("offers the maximum of 30 days and displays the server's actual expiry", async () => {
    const user = userEvent.setup()
    const expiresAt = 1_900_000_000_000
    mockCreate.mockResolvedValue({ code: "M", url: "https://share.test/v/M#k=K", expiresAt })
    open()
    await user.click(screen.getAllByRole("combobox")[0])
    expect(screen.queryByRole("option", { name: "Never" })).not.toBeInTheDocument()
    await user.click(screen.getByRole("option", { name: "Up to 30 days" }))
    await user.click(screen.getByRole("button", { name: "Create link" }))
    await screen.findByText("Your share link is ready")
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ ttlSeconds: 2_592_000 }),
      undefined
    )
    expect(screen.getByText(`Expires: ${new Date(expiresAt).toLocaleString()}`)).toBeInTheDocument()
  })

  it("copies the link", async () => {
    mockCreate.mockResolvedValue({ code: "A", url: "https://share.test/v/A#k=K" })
    open()
    fireEvent.click(screen.getByRole("button", { name: "Create link" }))
    await screen.findByText("Your share link is ready")
    fireEvent.click(screen.getByRole("button", { name: "Copy" }))
    await waitFor(() =>
      expect(navigator.clipboard.writeText as jest.Mock).toHaveBeenCalledWith(
        "https://share.test/v/A#k=K"
      )
    )
  })

  it("revokes the created link", async () => {
    mockCreate.mockResolvedValue({ code: "Z", url: "https://share.test/v/Z#k=K" })
    mockRevoke.mockResolvedValue(undefined)
    open()
    fireEvent.click(screen.getByRole("button", { name: "Create link" }))
    await screen.findByText("Your share link is ready")
    fireEvent.click(screen.getByRole("button", { name: "Revoke" }))
    await waitFor(() => expect(mockRevoke).toHaveBeenCalledWith("Z"))
    expect(await screen.findByText("Link revoked")).toBeInTheDocument()
  })

  it("shows the unconfigured state and fires onConfigure", async () => {
    mockCreate.mockRejectedValue(new ShareNotConfiguredError())
    const onConfigure = jest.fn()
    open({ onConfigure })
    fireEvent.click(screen.getByRole("button", { name: "Create link" }))
    expect(await screen.findByText("Share service not set up")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Open settings" }))
    expect(onConfigure).toHaveBeenCalled()
  })

  it("shows a generic error when creation fails", async () => {
    mockCreate.mockRejectedValue(new Error("boom"))
    open()
    fireEvent.click(screen.getByRole("button", { name: "Create link" }))
    expect(await screen.findByText("Could not create the share link.")).toBeInTheDocument()
  })

  it.each([new SharePayloadTooLargeError(11, 10), new ShareRequestError(413, "too large")])(
    "explains how to recover from an oversized multi-image share",
    async (error) => {
      mockCreate.mockRejectedValue(error)
      open()
      fireEvent.click(screen.getByRole("button", { name: "Create link" }))
      expect(
        await screen.findByText("This share is too large. Remove some images or export it locally.")
      ).toBeInTheDocument()
    }
  )

  it("previews the payload locally without creating a link", async () => {
    open()
    fireEvent.click(screen.getByRole("button", { name: "Preview" }))
    // chat-html renders into the sandboxed iframe titled "Shared conversation".
    expect(await screen.findByTitle("Shared conversation")).toBeInTheDocument()
    expect(mockCreate).not.toHaveBeenCalled()
    // Closing the preview returns to the lifecycle form.
    fireEvent.click(screen.getByRole("button", { name: "Close preview" }))
    expect(screen.getByText("Expires")).toBeInTheDocument()
  })

  it("switches to burn mode and passes burnAfterRead", async () => {
    mockCreate.mockResolvedValue({ code: "B", url: "https://share.test/v/B#k=K" })
    open()
    // Open the "View limit" select and choose burn-after-reading.
    fireEvent.click(screen.getByText("Unlimited"))
    fireEvent.click(await screen.findByText("Burn after reading"))
    fireEvent.click(screen.getByRole("button", { name: "Create link" }))
    await waitFor(() =>
      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({ burnAfterRead: true }),
        undefined
      )
    )
  })

  describe("files (ADR-0222)", () => {
    const SESSION = { id: "s1" }
    const file = (path: string, sensitive = false) => ({
      path: path as FileSpacePath,
      name: path.slice(path.lastIndexOf("/") + 1),
      mime: "text/plain",
      size: 1024,
      sensitive,
      open: jest.fn(),
    })
    const selectionOf = (files: ReturnType<typeof file>[], extra = {}) => ({
      ...NO_SELECTION,
      loaded: null,
      expanded: { files, skippedSensitive: 0, truncated: false, issues: [], ...extra },
    })
    const BUNDLE: SharePayload = {
      kind: "file-bundle",
      mime: "application/json",
      data: "",
      encoding: "utf8",
    }

    it("carries the chosen files and records the source conversation", async () => {
      mockSelection.mockReturnValue(selectionOf([file("/workspace/a.txt")]))
      mockCreate.mockResolvedValue({ code: "F", url: "https://share.test/v/F#k=K" })
      open({
        buildPayload: () => BUNDLE,
        files: {
          session: SESSION,
          initialSelection: ["/workspace/a.txt" as FileSpacePath],
          required: true,
        },
      })
      expect(screen.getByText("1 file · 1.0 KB")).toBeInTheDocument()
      expect(screen.queryByRole("button", { name: "Preview" })).not.toBeInTheDocument()
      fireEvent.click(screen.getByRole("button", { name: "Create link" }))
      await screen.findByText("Your share link is ready")
      expect(mockSelection).toHaveBeenCalledWith("s1", ["/workspace/a.txt"])
      expect(mockAuthorize).toHaveBeenCalledWith(SESSION)
      const [input] = mockCreate.mock.calls[0]
      expect(input).toMatchObject({ payload: BUNDLE, sessionId: "s1" })
      expect(input.files.map((f: { path: string }) => f.path)).toEqual(["/workspace/a.txt"])
      expect(screen.getByText("Carries 1 file.")).toBeInTheDocument()
    })

    it("needs at least one file for a file bundle", () => {
      open({ buildPayload: () => BUNDLE, files: { session: SESSION, required: true } })
      expect(screen.getByRole("button", { name: "Create link" })).toBeDisabled()
    })

    it("holds a credential-like file back until it is ticked by path", async () => {
      mockSelection.mockReturnValue(selectionOf([file("/workspace/.env", true)]))
      open({ files: { session: SESSION, initialSelection: ["/workspace" as FileSpacePath] } })
      expect(screen.getByText("These look like credentials")).toBeInTheDocument()
      expect(screen.getByText("0 files · 0 B")).toBeInTheDocument()
      fireEvent.click(screen.getByRole("checkbox", { name: "Include /workspace/.env" }))
      expect(screen.getByText("1 file · 1.0 KB")).toBeInTheDocument()
    })

    it("reports what a folder left out and why a path contributed nothing", () => {
      mockSelection.mockReturnValue(
        selectionOf([file("/workspace/a.txt")], {
          skippedSensitive: 2,
          issues: [{ path: "/roots/x", reason: "offline" }],
        })
      )
      open({ files: { session: SESSION, initialSelection: ["/workspace" as FileSpacePath] } })
      expect(
        screen.getByText(/2 files that look like credentials were left out/)
      ).toBeInTheDocument()
      expect(screen.getByText("/roots/x is on a host that is offline.")).toBeInTheDocument()
    })

    it("offers only the lifetimes the policy allows once files are carried", async () => {
      const user = userEvent.setup()
      mockSelection.mockReturnValue(selectionOf([file("/workspace/a.txt")]))
      mockPolicy.mockResolvedValue({
        policy: { ...DEFAULT_FILE_SHARING_POLICY, maxSnapshotTtlSeconds: 86_400 },
        local: DEFAULT_FILE_SHARING_POLICY,
      })
      open({ files: { session: SESSION, initialSelection: ["/workspace/a.txt" as FileSpacePath] } })
      expect(
        await screen.findByText("Lifetimes are limited by your file-sharing policy.")
      ).toBeInTheDocument()
      await user.click(screen.getAllByRole("combobox")[0])
      expect(screen.queryByRole("option", { name: "In 7 days" })).not.toBeInTheDocument()
      expect(screen.getByRole("option", { name: "In 24 hours" })).toBeInTheDocument()
    })

    it("refuses when the policy forbids publishing files", async () => {
      mockSelection.mockReturnValue(selectionOf([file("/workspace/a.txt")]))
      mockPolicy.mockResolvedValue({
        policy: { ...DEFAULT_FILE_SHARING_POLICY, allowPublicSnapshots: false },
        local: DEFAULT_FILE_SHARING_POLICY,
      })
      open({ files: { session: SESSION, initialSelection: ["/workspace/a.txt" as FileSpacePath] } })
      expect(
        await screen.findByText(
          "Your file-sharing policy does not allow publishing files as links."
        )
      ).toBeInTheDocument()
      expect(screen.getByRole("button", { name: "Create link" })).toBeDisabled()
    })

    describe("cancelling an upload", () => {
      // Report progress, then fail as `createShareLink` does once aborted:
      // with the outcome of withdrawing the half-made link.
      const hangUntilAborted = (revoked: boolean) =>
        mockCreate.mockImplementation(
          (input: {
            signal: AbortSignal
            onProgress: (progress: Record<string, unknown>) => void
          }) => {
            input.onProgress({
              phase: "uploading",
              fileIndex: 0,
              fileCount: 1,
              path: "/workspace/a.txt",
              done: 0,
              total: 1024,
            })
            return new Promise((_, reject) =>
              input.signal.addEventListener("abort", () =>
                reject(new ShareFilesUploadError(revoked, new Error("aborted")))
              )
            )
          }
        )

      it("says nothing stays published once the link is withdrawn", async () => {
        mockSelection.mockReturnValue(selectionOf([file("/workspace/a.txt")]))
        hangUntilAborted(true)
        open({
          files: { session: SESSION, initialSelection: ["/workspace/a.txt" as FileSpacePath] },
        })
        fireEvent.click(screen.getByRole("button", { name: "Create link" }))
        expect(await screen.findByText("Encrypting and uploading file 1 of 1…")).toBeInTheDocument()
        fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
        expect(
          await screen.findByText("Sharing was cancelled. Nothing stays published.")
        ).toBeInTheDocument()
      })

      it("says the link is still live when withdrawing it failed", async () => {
        mockSelection.mockReturnValue(selectionOf([file("/workspace/a.txt")]))
        hangUntilAborted(false)
        open({
          files: { session: SESSION, initialSelection: ["/workspace/a.txt" as FileSpacePath] },
        })
        fireEvent.click(screen.getByRole("button", { name: "Create link" }))
        fireEvent.click(await screen.findByRole("button", { name: "Cancel" }))
        expect(
          await screen.findByText(
            "Uploading the files failed and the link could not be withdrawn. Revoke it from My Shares."
          )
        ).toBeInTheDocument()
      })
    })

    it("loads the policy when opened from its own trigger, not only when controlled", async () => {
      const user = userEvent.setup()
      mockSelection.mockReturnValue(selectionOf([file("/workspace/a.txt")]))
      mockPolicy.mockResolvedValue({
        policy: { ...DEFAULT_FILE_SHARING_POLICY, allowPublicSnapshots: false },
        local: DEFAULT_FILE_SHARING_POLICY,
      })
      render(
        <ShareLinkDialog
          buildPayload={buildPayload}
          files={{ session: SESSION, initialSelection: ["/workspace/a.txt" as FileSpacePath] }}
          trigger={<button type="button">Share it</button>}
        />
      )
      expect(mockPolicy).not.toHaveBeenCalled()
      await user.click(screen.getByRole("button", { name: "Share it" }))
      expect(
        await screen.findByText(
          "Your file-sharing policy does not allow publishing files as links."
        )
      ).toBeInTheDocument()
      expect(mockPolicy).toHaveBeenCalledTimes(1)
    })

    it("explains a refusal from the shared conversation's organization", async () => {
      const { SharedSessionAccessError } = jest.requireActual(
        "@/lib/collab/shared-session-access"
      ) as typeof import("@/lib/collab/shared-session-access")
      mockSelection.mockReturnValue(selectionOf([file("/workspace/a.txt")]))
      mockAuthorize.mockRejectedValue(new SharedSessionAccessError("forbidden"))
      open({ files: { session: SESSION, initialSelection: ["/workspace/a.txt" as FileSpacePath] } })
      fireEvent.click(screen.getByRole("button", { name: "Create link" }))
      expect(await screen.findByText(/your role or your organization’s policy/)).toBeInTheDocument()
      expect(mockCreate).not.toHaveBeenCalled()
    })

    it("says when a file changed under the upload or the link could not be withdrawn", async () => {
      mockSelection.mockReturnValue(selectionOf([file("/workspace/a.txt")]))
      mockCreate.mockRejectedValueOnce(
        new ShareFilesUploadError(true, new ShareFileChangedError("/workspace/a.txt"))
      )
      open({ files: { session: SESSION, initialSelection: ["/workspace/a.txt" as FileSpacePath] } })
      fireEvent.click(screen.getByRole("button", { name: "Create link" }))
      expect(await screen.findByText(/changed while it was being shared/)).toBeInTheDocument()

      mockCreate.mockRejectedValueOnce(new ShareFilesUploadError(false, new Error("network")))
      fireEvent.click(screen.getByRole("button", { name: "Create link" }))
      expect(await screen.findByText(/Revoke it from My Shares/)).toBeInTheDocument()
    })

    it("hands a transcript's own attachments to the share", async () => {
      const attachment = {
        path: "/attachments/big.png",
        name: "big.png",
        mime: "image/png",
        open: jest.fn(),
      }
      mockCreate.mockResolvedValue({ code: "A", url: "https://share.test/v/A#k=K" })
      open({ buildPayload: async () => ({ payload: PAYLOAD, attachments: [attachment] }) })
      fireEvent.click(screen.getByRole("button", { name: "Create link" }))
      await screen.findByText("Your share link is ready")
      expect(mockCreate.mock.calls[0][0].files).toEqual([attachment])
      expect(mockPolicy).toHaveBeenCalled()
    })
  })
})
