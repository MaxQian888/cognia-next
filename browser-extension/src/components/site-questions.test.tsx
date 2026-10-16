/** @jest-environment jsdom */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"

import { PENDING_SITE_QUESTIONS_KEY } from "@ext/src/lib/agent/site-permissions"
import type { BrowserApi } from "@ext/src/lib/browser-api"

import { SiteQuestions, siteOperationMessage } from "./site-questions"

function fakeApi(questions: unknown) {
  const answers: [string, string][] = []
  const listeners = new Set<(value: unknown) => void>()
  const api = {
    message: (key: string, subs?: string[]) => (subs ? `${key}:${subs.join("/")}` : key),
    readSession: async (key: string) => (key === PENDING_SITE_QUESTIONS_KEY ? questions : null),
    onSessionChange: (_key: string, listener: (value: unknown) => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    read: async () => null,
    onStorageChange: () => () => undefined,
    answerSiteQuestion: async (id: string, answer: string) => {
      answers.push([id, answer])
    },
  } as unknown as BrowserApi
  return { api, answers, listeners }
}

describe("SiteQuestions", () => {
  it("renders nothing without a question", async () => {
    const { api } = fakeApi([])
    const { container } = render(<SiteQuestions api={api} />)
    await act(async () => undefined)
    expect(container).toBeEmptyDOMElement()
  })

  it("asks about each site and sends the person's answer", async () => {
    const { api, answers } = fakeApi([
      { id: "q1", session: "s", origin: "https://shop.test", operation: "act", askedAt: 1 },
      { id: "q2", session: "s", origin: "https://bank.test", operation: "navigate", askedAt: 2 },
    ])
    render(<SiteQuestions api={api} />)
    expect(await screen.findByTestId("site-question-q1")).toHaveTextContent(
      "siteQuestionTitle:shop.test"
    )
    expect(screen.getByTestId("site-question-q2")).toHaveTextContent(
      "siteQuestionDetail:siteOpNavigate"
    )
    fireEvent.click(screen.getByTestId("site-allow-once-q1"))
    fireEvent.click(screen.getByTestId("site-never-q2"))
    await waitFor(() =>
      expect(answers).toEqual([
        ["q1", "once"],
        ["q2", "never"],
      ])
    )
  })

  it("disappears once the question is answered elsewhere", async () => {
    const { api, listeners } = fakeApi([
      { id: "q1", session: "s", origin: "https://a.test", operation: "act", askedAt: 1 },
    ])
    render(<SiteQuestions api={api} />)
    await screen.findByTestId("site-question-q1")
    act(() => {
      for (const listener of listeners) listener([])
    })
    expect(screen.queryByTestId("site-questions")).toBeNull()
  })
})

describe("siteOperationMessage", () => {
  it("says what the agent wanted in words", () => {
    const message = (key: string) => key
    expect(siteOperationMessage("create_page", message)).toBe("siteOpNavigate")
    expect(siteOperationMessage("set_files", message)).toBe("siteOpAct")
    expect(siteOperationMessage("snapshot", message)).toBe("siteOpRead")
  })
})
