/** @jest-environment jsdom */
import { fireEvent, render, screen, waitFor } from "@testing-library/react"

import { MobileFleetReply } from "./mobile-fleet-reply"

const sendMock = jest.fn()
jest.mock("@/lib/fleet/fleet-remote-actions", () => ({
  fleetRemoteSendMessage: (...a: unknown[]) => sendMock(...a),
}))
const toastErrorMock = jest.fn()
jest.mock("sonner", () => ({ toast: { error: (...a: unknown[]) => toastErrorMock(...a) } }))

describe("MobileFleetReply", () => {
  beforeEach(() => {
    sendMock.mockReset()
    toastErrorMock.mockReset()
  })

  it("reveals an input, sends, then collapses", async () => {
    sendMock.mockResolvedValue("cmd-1")
    render(<MobileFleetReply sessionId="s1" />)
    fireEvent.click(screen.getByTestId("mobile-fleet-reply-open"))
    fireEvent.change(screen.getByTestId("mobile-fleet-reply-input"), {
      target: { value: "continue" },
    })
    fireEvent.click(screen.getByTestId("mobile-fleet-reply-send"))
    await waitFor(() => expect(sendMock).toHaveBeenCalledWith("s1", "continue"))
    await waitFor(() => expect(screen.getByTestId("mobile-fleet-reply-open")).toBeInTheDocument())
  })

  it("toasts on a send failure", async () => {
    sendMock.mockRejectedValue(new Error("offline"))
    render(<MobileFleetReply sessionId="s1" />)
    fireEvent.click(screen.getByTestId("mobile-fleet-reply-open"))
    fireEvent.change(screen.getByTestId("mobile-fleet-reply-input"), { target: { value: "go" } })
    fireEvent.click(screen.getByTestId("mobile-fleet-reply-send"))
    await waitFor(() => expect(toastErrorMock).toHaveBeenCalledTimes(1))
  })

  it("sends on Enter and ignores an empty input", async () => {
    sendMock.mockResolvedValue("cmd-2")
    render(<MobileFleetReply sessionId="s1" />)
    fireEvent.click(screen.getByTestId("mobile-fleet-reply-open"))
    const input = screen.getByTestId("mobile-fleet-reply-input")
    fireEvent.keyDown(input, { key: "Enter" })
    expect(sendMock).not.toHaveBeenCalled()
    fireEvent.change(input, { target: { value: "hi" } })
    fireEvent.keyDown(input, { key: "Enter" })
    await waitFor(() => expect(sendMock).toHaveBeenCalledWith("s1", "hi"))
  })

  it("collapses on Escape", () => {
    render(<MobileFleetReply sessionId="s1" />)
    fireEvent.click(screen.getByTestId("mobile-fleet-reply-open"))
    fireEvent.keyDown(screen.getByTestId("mobile-fleet-reply-input"), { key: "Escape" })
    expect(screen.getByTestId("mobile-fleet-reply-open")).toBeInTheDocument()
  })
})
