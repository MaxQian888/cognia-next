import { render, screen, fireEvent, waitFor } from "@testing-library/react"
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
  return {
    createShareLink: (...a: unknown[]) => mockCreate(...a),
    revokeShareLink: (...a: unknown[]) => mockRevoke(...a),
    ShareNotConfiguredError,
    SharePayloadTooLargeError,
    ShareRequestError,
  }
})

import {
  ShareNotConfiguredError,
  SharePayloadTooLargeError,
  ShareRequestError,
} from "@/lib/share/client"

const PAYLOAD: SharePayload = {
  kind: "chat-html",
  mime: "text/html",
  data: "<p/>",
  encoding: "utf8",
  title: "T",
}
const buildPayload = () => PAYLOAD

beforeEach(() => {
  jest.clearAllMocks()
  Object.assign(navigator, { clipboard: { writeText: jest.fn().mockResolvedValue(undefined) } })
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
      })
    )
    expect(screen.getByDisplayValue("https://share.test/v/AbC#k=KEY")).toBeInTheDocument()
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
      expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ burnAfterRead: true }))
    )
  })
})
