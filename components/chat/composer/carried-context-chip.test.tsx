import { fireEvent, render, screen } from "@testing-library/react"

import { useChatStore } from "@/stores/chat"
import { ComposerSessionProvider } from "./composer-session-context"
import { CarriedContextChips } from "./carried-context-chip"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `t:${key}:${JSON.stringify(values)}` : `t:${key}`,
}))

beforeEach(() => {
  useChatStore.getState().clear()
  useChatStore.getState().setActiveSession("focused")
})

it("renders nothing while no envelope is carried", () => {
  render(<CarriedContextChips />)
  expect(screen.queryByTestId("composer-carried-context-chip")).toBeNull()
})

it("shows one chip per carried envelope, with its reference count and titles", () => {
  useChatStore.getState().addCarriedPreambles(
    [
      {
        preamble: "<one>",
        summary: {
          sections: ["references"],
          references: [
            { kind: "file", title: "spec.md" },
            { kind: "web", title: "RFC 9110" },
          ],
        },
      },
      { preamble: "<two>" },
    ],
    "focused"
  )
  render(<CarriedContextChips />)
  const chips = screen.getAllByTestId("composer-carried-context-chip")
  expect(chips).toHaveLength(2)
  expect(chips[0]).toHaveTextContent('t:references:{"count":2}')
  expect(chips[0]).toHaveAttribute("title", "spec.md, RFC 9110")
  expect(chips[1]).toHaveTextContent("t:generic")
  expect(chips[1]).toHaveAttribute("title", "t:hint")
})

it("removes exactly the envelope whose chip was dismissed, in the named pane", () => {
  useChatStore.getState().addCarriedPreambles([{ preamble: "<focused>" }], "focused")
  useChatStore.getState().addCarriedPreambles([{ preamble: "<a>" }, { preamble: "<b>" }], "side")
  render(
    <ComposerSessionProvider value="side">
      <CarriedContextChips />
    </ComposerSessionProvider>
  )
  fireEvent.click(screen.getAllByTestId("composer-carried-context-remove")[0]!)
  expect(useChatStore.getState().sessions.side?.carriedPreambles).toEqual([{ preamble: "<b>" }])
  expect(useChatStore.getState().sessions.focused?.carriedPreambles).toEqual([
    { preamble: "<focused>" },
  ])
})

it("does not stage the same envelope twice", () => {
  useChatStore.getState().addCarriedPreambles([{ preamble: "<x>" }], "focused")
  useChatStore.getState().addCarriedPreambles([{ preamble: "<x>" }], "focused")
  render(<CarriedContextChips />)
  expect(screen.getAllByTestId("composer-carried-context-chip")).toHaveLength(1)
})
