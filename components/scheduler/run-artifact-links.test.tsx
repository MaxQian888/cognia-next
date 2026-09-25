/** @jest-environment jsdom */
/**
 * The link that reaches a scheduled run's actual product.
 *
 * The derivation is covered in `lib/scheduler/run-artifact-link.test.ts`. What
 * matters here is the navigation split: a session is focused in the chat pane
 * rather than routed to, because the pane IS the root route.
 */

const push = jest.fn()
jest.mock("next/navigation", () => ({ useRouter: () => ({ push }) }))
jest.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { focusSessionInItsWorkspace, RunArtifactLinks } from "./run-artifact-links"

const setActiveSession = jest.fn()
jest.mock("@/stores/chat", () => ({
  useChatStore: { getState: () => ({ setActiveSession }) },
}))
const getSession = jest.fn()
jest.mock("@/lib/db/sessions", () => ({ getSession: (id: string) => getSession(id) }))
const followSession = jest.fn(
  (_session: unknown, id: string, select: (sessionId: string) => void) => select(id)
)
jest.mock("@/hooks/global-search/use-global-search-actions", () => ({
  focusSession: (...args: [unknown, string, (id: string) => void]) => followSession(...args),
}))

beforeEach(() => {
  push.mockClear()
})

it("renders nothing when the run produced nothing addressable", () => {
  const { container } = render(<RunArtifactLinks output={{ exit_code: 0 }} />)
  expect(container).toBeEmptyDOMElement()
})

it("focuses the session AND routes to the chat pane", async () => {
  const onOpenSession = jest.fn()
  render(<RunArtifactLinks output={{ sessionId: "sess-1" }} onOpenSession={onOpenSession} />)

  await userEvent.click(screen.getByTestId("run-artifact-session"))

  expect(onOpenSession).toHaveBeenCalledWith("sess-1")
  // Focus first, route second. Routing first would render the pane against
  // whatever session was previously active.
  expect(push).toHaveBeenCalledWith("/")
  expect(onOpenSession.mock.invocationCallOrder[0]).toBeLessThan(push.mock.invocationCallOrder[0])
})

it("routes to the owning surface for everything that has one", async () => {
  render(<RunArtifactLinks output={{ planId: "plan-1" }} />)
  await userEvent.click(screen.getByTestId("run-artifact-plan"))
  expect(push).toHaveBeenCalledWith("/agent-runs")
})

it("offers both when a goal run also names its session", async () => {
  const onOpenSession = jest.fn()
  render(
    <RunArtifactLinks output={{ goalId: "g1", sessionId: "s1" }} onOpenSession={onOpenSession} />
  )
  expect(screen.getByTestId("run-artifact-goal")).toBeInTheDocument()
  expect(screen.getByTestId("run-artifact-session")).toBeInTheDocument()
})

describe("focusSessionInItsWorkspace", () => {
  beforeEach(() => {
    setActiveSession.mockClear()
    followSession.mockClear()
  })

  it("follows the session into its own workspace, then focuses it", async () => {
    const session = { id: "sess-9", projectId: "proj-b" }
    getSession.mockResolvedValueOnce(session)
    await focusSessionInItsWorkspace("sess-9")
    expect(followSession).toHaveBeenCalledWith(session, "sess-9", expect.any(Function))
    expect(setActiveSession).toHaveBeenCalledWith("sess-9")
  })

  it("still focuses a session it could not load", async () => {
    getSession.mockRejectedValueOnce(new Error("gone"))
    await focusSessionInItsWorkspace("sess-x")
    expect(followSession).toHaveBeenCalledWith(undefined, "sess-x", expect.any(Function))
    expect(setActiveSession).toHaveBeenCalledWith("sess-x")
  })

  it("routes to the chat pane only after the session is focused", async () => {
    const user = userEvent.setup()
    getSession.mockResolvedValueOnce({ id: "sess-1" })
    render(<RunArtifactLinks output={{ sessionId: "sess-1" }} />)
    await user.click(screen.getByRole("button"))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(setActiveSession).toHaveBeenCalledWith("sess-1")
    expect(push).toHaveBeenCalledWith("/")
    expect(setActiveSession.mock.invocationCallOrder[0]).toBeLessThan(
      push.mock.invocationCallOrder[0]
    )
  })
})
