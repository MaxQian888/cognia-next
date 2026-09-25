import React from "react"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import ShareViewPage from "./page"
import { ShareGuestShell } from "@/components/share/share-guest-shell"
import { resolveShareEndpoint } from "@/lib/share/config"
import { loadShare, decryptEnvelope } from "@/lib/share/load"
import type { SharePayload } from "@/lib/share/types"

jest.mock("@/lib/share/config", () => ({
  resolveShareEndpoint: jest.fn(),
  defaultShareBaseUrl: () => "https://share.default",
}))

jest.mock("@/lib/share/load", () => ({
  loadShare: jest.fn(),
  decryptEnvelope: jest.fn(),
}))

jest.mock("@/components/share/payload-view", () => ({
  PayloadView: ({ payload, canImport }: { payload: SharePayload; canImport?: boolean }) => (
    <div data-testid="payload" data-can-import={String(canImport)}>
      {payload.kind}
    </div>
  ),
}))

jest.mock("@/lib/share/viewer-context", () => ({
  resolveShareViewerRunsInApp: jest.fn(),
}))

import { resolveShareViewerRunsInApp } from "@/lib/share/viewer-context"

const mockRunsInApp = resolveShareViewerRunsInApp as jest.MockedFunction<
  typeof resolveShareViewerRunsInApp
>
const mockResolveEndpoint = resolveShareEndpoint as jest.MockedFunction<typeof resolveShareEndpoint>
const mockLoadShare = loadShare as jest.MockedFunction<typeof loadShare>
const mockDecrypt = decryptEnvelope as jest.MockedFunction<typeof decryptEnvelope>

const PAYLOAD: SharePayload = {
  kind: "chat-md",
  mime: "text/markdown",
  data: "# x",
  encoding: "utf8",
}

beforeEach(() => {
  jest.clearAllMocks()
  mockRunsInApp.mockResolvedValue(false)
  mockResolveEndpoint.mockResolvedValue({ baseUrl: "https://x", uploadSecret: "" })
})

describe("ShareViewPage", () => {
  it("renders the payload once loaded", async () => {
    mockLoadShare.mockResolvedValue({ status: "ready", payload: PAYLOAD })
    render(<ShareViewPage />)
    await waitFor(() => expect(screen.getByTestId("payload")).toHaveTextContent("chat-md"))
    // The in-app copy reads the endpoint from the open account's settings.
    expect(mockLoadShare).toHaveBeenCalledWith("https://x", expect.any(String), expect.any(String))
  })

  it("shows the unavailable state", async () => {
    mockLoadShare.mockResolvedValue({ status: "unavailable" })
    render(<ShareViewPage />)
    await waitFor(() =>
      expect(screen.getByText("This link is no longer available")).toBeInTheDocument()
    )
    expect(screen.getByRole("banner")).toBeInTheDocument()
    expect(screen.getByRole("main")).toBeInTheDocument()
    expect(screen.getByRole("contentinfo")).toBeInTheDocument()
  })

  it("maps an error reason to a translated message", async () => {
    mockLoadShare.mockResolvedValue({ status: "error", reason: "invalid-key" })
    render(<ShareViewPage />)
    await waitFor(() =>
      expect(screen.getByText("This link is invalid or its key is wrong.")).toBeInTheDocument()
    )
  })

  it("prompts for a passphrase and decrypts on submit", async () => {
    const envelope = { v: 1 } as never
    mockLoadShare.mockResolvedValue({ status: "passphrase", envelope, key: "k" })
    mockDecrypt.mockResolvedValue({ status: "ready", payload: PAYLOAD })

    render(<ShareViewPage />)
    await waitFor(() => expect(screen.getByText("Passphrase required")).toBeInTheDocument())

    fireEvent.change(screen.getByLabelText("Passphrase"), { target: { value: "hunter2" } })
    fireEvent.click(screen.getByText("Unlock"))

    await waitFor(() => expect(screen.getByTestId("payload")).toBeInTheDocument())
    expect(mockDecrypt).toHaveBeenCalledWith(envelope, "k", "hunter2")
  })

  // The importable kinds offer to write into the reader's own library, which
  // only means anything where there IS one. The public deployment runs this
  // exact route, so the answer is resolved rather than assumed.
  it("passes the in-app verdict down to the payload view", async () => {
    mockLoadShare.mockResolvedValue({ status: "ready", payload: PAYLOAD })
    mockRunsInApp.mockResolvedValue(true)
    render(<ShareViewPage />)
    await waitFor(() =>
      expect(screen.getByTestId("payload")).toHaveAttribute("data-can-import", "true")
    )
  })

  it("defaults to no import, and stays there when the verdict cannot be resolved", async () => {
    mockLoadShare.mockResolvedValue({ status: "ready", payload: PAYLOAD })
    mockRunsInApp.mockRejectedValue(new Error("no settings"))
    render(<ShareViewPage />)
    await waitFor(() => expect(screen.getByTestId("payload")).toBeInTheDocument())
    expect(screen.getByTestId("payload")).toHaveAttribute("data-can-import", "false")
  })

  // ADR-0037, "The anonymous visitor": with no account open, AccountGate
  // renders this page in ShareGuestShell. There is no settings row, keyring or
  // library then, and reading the first two would open a database in the
  // visitor's browser.
  describe("for a guest", () => {
    it("reads from the build-time endpoint without touching settings", async () => {
      mockLoadShare.mockResolvedValue({ status: "ready", payload: PAYLOAD })
      render(
        <ShareGuestShell>
          <ShareViewPage />
        </ShareGuestShell>
      )
      await waitFor(() => expect(screen.getByTestId("payload")).toHaveTextContent("chat-md"))
      expect(mockLoadShare).toHaveBeenCalledTimes(1)
      expect(mockLoadShare).toHaveBeenCalledWith(
        "https://share.default",
        expect.any(String),
        expect.any(String)
      )
      expect(mockResolveEndpoint).not.toHaveBeenCalled()
    })

    it("offers no import and never asks whether it runs in the app", async () => {
      mockLoadShare.mockResolvedValue({ status: "ready", payload: PAYLOAD })
      // Would say yes if asked: a guest on a self-hosted origin is not the
      // public host, but it still has no library to import into.
      mockRunsInApp.mockResolvedValue(true)
      render(
        <ShareGuestShell>
          <ShareViewPage />
        </ShareGuestShell>
      )
      await waitFor(() => expect(screen.getByTestId("payload")).toBeInTheDocument())
      expect(screen.getByTestId("payload")).toHaveAttribute("data-can-import", "false")
      expect(mockRunsInApp).not.toHaveBeenCalled()
    })

    it("keeps the passphrase round-trip", async () => {
      const envelope = { v: 1 } as never
      mockLoadShare.mockResolvedValue({ status: "passphrase", envelope, key: "k" })
      mockDecrypt.mockResolvedValue({ status: "ready", payload: PAYLOAD })
      render(
        <ShareGuestShell>
          <ShareViewPage />
        </ShareGuestShell>
      )
      await waitFor(() => expect(screen.getByText("Passphrase required")).toBeInTheDocument())
      fireEvent.change(screen.getByLabelText("Passphrase"), { target: { value: "hunter2" } })
      fireEvent.click(screen.getByText("Unlock"))
      await waitFor(() => expect(screen.getByTestId("payload")).toBeInTheDocument())
      expect(mockDecrypt).toHaveBeenCalledWith(envelope, "k", "hunter2")
    })
  })
})
