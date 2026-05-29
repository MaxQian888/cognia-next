import React from "react"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import ShareViewPage from "./page"
import { loadShare, decryptEnvelope } from "@/lib/share/load"
import type { SharePayload } from "@/lib/share/types"

jest.mock("@/lib/share/config", () => ({
  resolveShareEndpoint: jest.fn().mockResolvedValue({ baseUrl: "https://x", uploadSecret: "" }),
}))

jest.mock("@/lib/share/load", () => ({
  loadShare: jest.fn(),
  decryptEnvelope: jest.fn(),
}))

jest.mock("@/components/share/payload-view", () => ({
  PayloadView: ({ payload }: { payload: SharePayload }) => (
    <div data-testid="payload">{payload.kind}</div>
  ),
}))

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
})

describe("ShareViewPage", () => {
  it("renders the payload once loaded", async () => {
    mockLoadShare.mockResolvedValue({ status: "ready", payload: PAYLOAD })
    render(<ShareViewPage />)
    await waitFor(() => expect(screen.getByTestId("payload")).toHaveTextContent("chat-md"))
  })

  it("shows the unavailable state", async () => {
    mockLoadShare.mockResolvedValue({ status: "unavailable" })
    render(<ShareViewPage />)
    await waitFor(() =>
      expect(screen.getByText("This link is no longer available")).toBeInTheDocument()
    )
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
})
