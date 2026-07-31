/**
 * @jest-environment jsdom
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { IslandReply } from "./island-reply"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

const sendMock = jest.fn()
jest.mock("@/lib/tauri/fleet", () => ({
  fleetOpencodeSendMessage: (...args: unknown[]) => sendMock(...args),
}))

beforeEach(() => {
  sendMock.mockReset()
  sendMock.mockResolvedValue("cmd-1")
})

describe("IslandReply", () => {
  it("expands to an input on click and sends on Enter", async () => {
    render(<IslandReply sessionId="oc-1" />)
    fireEvent.click(screen.getByTestId("island-reply-open"))
    const input = screen.getByTestId("island-reply-input")
    fireEvent.change(input, { target: { value: "continue please" } })
    fireEvent.keyDown(input, { key: "Enter" })
    await waitFor(() => expect(sendMock).toHaveBeenCalledWith("oc-1", "continue please"))
    // Collapses back after a successful send.
    await waitFor(() => expect(screen.queryByTestId("island-reply-input")).toBeNull())
  })

  it("sends via the send button", async () => {
    render(<IslandReply sessionId="oc-2" />)
    fireEvent.click(screen.getByTestId("island-reply-open"))
    fireEvent.change(screen.getByTestId("island-reply-input"), { target: { value: "hi" } })
    fireEvent.click(screen.getByTestId("island-reply-send"))
    await waitFor(() => expect(sendMock).toHaveBeenCalledWith("oc-2", "hi"))
  })

  it("does not send empty or whitespace-only text", () => {
    render(<IslandReply sessionId="oc-3" />)
    fireEvent.click(screen.getByTestId("island-reply-open"))
    const input = screen.getByTestId("island-reply-input")
    fireEvent.change(input, { target: { value: "   " } })
    expect(screen.getByTestId("island-reply-send")).toBeDisabled()
    fireEvent.keyDown(input, { key: "Enter" })
    expect(sendMock).not.toHaveBeenCalled()
  })

  it("collapses on Escape", () => {
    render(<IslandReply sessionId="oc-4" />)
    fireEvent.click(screen.getByTestId("island-reply-open"))
    fireEvent.keyDown(screen.getByTestId("island-reply-input"), { key: "Escape" })
    expect(screen.queryByTestId("island-reply-input")).toBeNull()
  })

  it("collapses on blur only when empty", () => {
    render(<IslandReply sessionId="oc-5" />)
    fireEvent.click(screen.getByTestId("island-reply-open"))
    const input = screen.getByTestId("island-reply-input")
    fireEvent.change(input, { target: { value: "draft" } })
    fireEvent.blur(input)
    // Non-empty → stays open so the draft isn't lost.
    expect(screen.getByTestId("island-reply-input")).toBeInTheDocument()
    fireEvent.change(input, { target: { value: "" } })
    fireEvent.blur(input)
    expect(screen.queryByTestId("island-reply-input")).toBeNull()
  })

  it("keeps the input open when the send fails", async () => {
    sendMock.mockResolvedValue(null)
    render(<IslandReply sessionId="oc-6" />)
    fireEvent.click(screen.getByTestId("island-reply-open"))
    fireEvent.change(screen.getByTestId("island-reply-input"), { target: { value: "x" } })
    fireEvent.click(screen.getByTestId("island-reply-send"))
    await waitFor(() => expect(sendMock).toHaveBeenCalled())
    expect(screen.getByTestId("island-reply-input")).toBeInTheDocument()
  })
})
