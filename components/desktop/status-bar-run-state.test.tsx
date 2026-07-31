/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: (ns: string) => (key: string) => `${ns}.${key}`,
}))

const chatRef = { status: "idle" as "idle" | "streaming" | "awaiting_approval" | "error" }
jest.mock("@/stores/chat/chat-store", () => ({
  useChatStore: (selector: (s: unknown) => unknown) => selector({ status: chatRef.status }),
}))

import { StatusBarRunState } from "./status-bar-run-state"

beforeEach(() => {
  chatRef.status = "idle"
})

describe("StatusBarRunState", () => {
  it.each([
    ["idle" as const, "desktop.statusBar.idle"],
    ["streaming" as const, "desktop.statusBar.streaming"],
    ["awaiting_approval" as const, "desktop.statusBar.awaitingApproval"],
    ["error" as const, "desktop.statusBar.error"],
  ])("renders the %s label", (status, label) => {
    chatRef.status = status
    render(<StatusBarRunState />)
    expect(screen.getByTestId("status-status")).toHaveTextContent(label)
    expect(screen.getByLabelText(label)).toBeInTheDocument()
  })

  it("pulses the dot while streaming", () => {
    chatRef.status = "streaming"
    const { container } = render(<StatusBarRunState />)
    expect(container.querySelector(".animate-pulse")).toBeTruthy()
  })

  it("does not pulse when idle", () => {
    const { container } = render(<StatusBarRunState />)
    expect(container.querySelector(".animate-pulse")).toBeNull()
  })

  it("stays out of the tab order — it is a readout, not a control", () => {
    render(<StatusBarRunState />)
    expect(screen.getByTestId("status-status")).toHaveAttribute("tabindex", "-1")
  })
})
