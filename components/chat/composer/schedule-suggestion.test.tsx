/** @jest-environment jsdom */

import { render, screen, act } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

const pushMock = jest.fn()
jest.mock("next/navigation", () => ({ useRouter: () => ({ push: pushMock }) }))
jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

import { ScheduleSuggestion } from "./schedule-suggestion"
import {
  __clearScheduledTaskDraftForTesting,
  consumeScheduledTaskDraft,
} from "@/lib/scheduler/task-draft-handoff"

const RECURRING = "每天早上九点提醒我看一下 PR 列表"
const ORDINARY = "帮我把这个函数重构成更小的几块，顺便补上类型"

function renderSuggestion(value: string, props: Record<string, unknown> = {}) {
  return render(<ScheduleSuggestion value={value} debounceMs={0} {...props} />)
}

beforeEach(() => {
  pushMock.mockClear()
  __clearScheduledTaskDraftForTesting()
})

describe("ScheduleSuggestion", () => {
  it("offers to schedule a line that reads as a recurring task", async () => {
    renderSuggestion(RECURRING)
    expect(await screen.findByTestId("composer-schedule-suggestion")).toBeInTheDocument()
  })

  it("stays out of the way for an ordinary request", async () => {
    renderSuggestion(ORDINARY)
    await act(async () => {
      await Promise.resolve()
    })
    expect(screen.queryByTestId("composer-schedule-suggestion")).not.toBeInTheDocument()
  })

  it("ignores short input and command / mention / shell lines", async () => {
    const { rerender } = renderSuggestion("每天")
    await act(async () => {
      await Promise.resolve()
    })
    expect(screen.queryByTestId("composer-schedule-suggestion")).not.toBeInTheDocument()

    for (const prefix of ["/", "!", "#", "@"]) {
      rerender(<ScheduleSuggestion value={`${prefix}${RECURRING}`} debounceMs={0} />)
      await act(async () => {
        await Promise.resolve()
      })
      expect(screen.queryByTestId("composer-schedule-suggestion")).not.toBeInTheDocument()
    }
  })

  it("stages a draft and routes to the scheduler on accept", async () => {
    const user = userEvent.setup()
    renderSuggestion(RECURRING, { sessionId: "sess-1" })
    await user.click(await screen.findByTestId("composer-schedule-suggestion-accept"))

    expect(pushMock).toHaveBeenCalledWith("/scheduler")
    const staged = consumeScheduledTaskDraft()
    expect(staged).not.toBeNull()
    expect(staged!.input.type).toBeDefined()
    expect(staged!.input.trigger).toBeDefined()
  })

  it("stays dismissed for the text that produced it", async () => {
    const user = userEvent.setup()
    renderSuggestion(RECURRING)
    await user.click(await screen.findByTestId("composer-schedule-suggestion-dismiss"))
    expect(screen.queryByTestId("composer-schedule-suggestion")).not.toBeInTheDocument()
  })

  it("never swallows the turn — it renders no form and no submit", async () => {
    renderSuggestion(RECURRING)
    const row = await screen.findByTestId("composer-schedule-suggestion")
    expect(row.querySelector("form")).toBeNull()
    expect(row.querySelector("textarea")).toBeNull()
  })
})
