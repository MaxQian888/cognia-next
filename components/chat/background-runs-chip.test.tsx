/** @jest-environment jsdom */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
}))

type Status = "idle" | "streaming" | "awaiting_approval" | "error"
const chatRef = {
  sessions: {} as Record<string, { status: Status }>,
  activeSessionId: null as string | null,
}
jest.mock("@/stores/chat/chat-store", () => ({
  useChatStore: (selector: (s: unknown) => unknown) =>
    selector({ sessions: chatRef.sessions, activeSessionId: chatRef.activeSessionId }),
}))

import { fireEvent, render, screen } from "@testing-library/react"

import { BackgroundRunsChip } from "./background-runs-chip"

const onSelect = jest.fn()

beforeEach(() => {
  onSelect.mockClear()
  chatRef.sessions = {}
  chatRef.activeSessionId = null
})

it("counts the turns running somewhere other than the focused conversation", () => {
  chatRef.sessions = {
    a: { status: "idle" },
    b: { status: "streaming" },
    c: { status: "awaiting_approval" },
  }
  chatRef.activeSessionId = "a"
  render(<BackgroundRunsChip onSelect={onSelect} />)

  expect(screen.getByTestId("background-runs-chip")).toHaveTextContent("2")
})

it("stays out of the way while only the conversation on screen is busy", () => {
  // A chip that lit up during ordinary single-conversation use would stop
  // meaning anything.
  chatRef.sessions = { a: { status: "streaming" } }
  chatRef.activeSessionId = "a"
  render(<BackgroundRunsChip onSelect={onSelect} />)

  expect(screen.queryByTestId("background-runs-chip")).toBeNull()
})

it("renders nothing when nothing is running", () => {
  chatRef.sessions = { a: { status: "idle" }, b: { status: "idle" } }
  chatRef.activeSessionId = "a"
  render(<BackgroundRunsChip onSelect={onSelect} />)

  expect(screen.queryByTestId("background-runs-chip")).toBeNull()
})

it("jumps to a background conversation on click", () => {
  chatRef.sessions = { a: { status: "idle" }, b: { status: "streaming" } }
  chatRef.activeSessionId = "a"
  render(<BackgroundRunsChip onSelect={onSelect} />)

  fireEvent.click(screen.getByTestId("background-runs-chip"))
  expect(onSelect).toHaveBeenCalledWith("b")
})

it("is reachable from the keyboard", () => {
  chatRef.sessions = { a: { status: "idle" }, b: { status: "streaming" } }
  chatRef.activeSessionId = "a"
  render(<BackgroundRunsChip onSelect={onSelect} />)

  const chip = screen.getByTestId("background-runs-chip")
  expect(chip).toHaveAttribute("tabindex", "0")
  fireEvent.keyDown(chip, { key: "Enter" })
  expect(onSelect).toHaveBeenCalledWith("b")
})

it("does not present itself as pressable when there is nowhere to go", () => {
  chatRef.sessions = { a: { status: "idle" }, b: { status: "streaming" } }
  chatRef.activeSessionId = "a"
  render(<BackgroundRunsChip />)

  const chip = screen.getByTestId("background-runs-chip")
  expect(chip).not.toHaveAttribute("role", "button")
  expect(chip).not.toHaveAttribute("tabindex")
})

it("names the count for assistive tech, not just the digit", () => {
  chatRef.sessions = { a: { status: "idle" }, b: { status: "streaming" } }
  chatRef.activeSessionId = "a"
  render(<BackgroundRunsChip onSelect={onSelect} />)

  expect(screen.getByTestId("background-runs-chip")).toHaveAccessibleName('count:{"count":1}')
})

it("counts a background failure, which is easiest of all to miss", () => {
  chatRef.sessions = { a: { status: "idle" }, b: { status: "error" } }
  chatRef.activeSessionId = "a"
  render(<BackgroundRunsChip onSelect={onSelect} />)

  expect(screen.getByTestId("background-runs-chip")).toHaveAttribute("data-count", "1")
})
