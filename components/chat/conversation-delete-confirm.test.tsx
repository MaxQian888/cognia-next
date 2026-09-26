/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import type { ChatSession } from "@cognia/agent-config-types"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
}))

const branchesRef: { current: number } = { current: 0 }
const listSessionBranches = jest.fn(async (_id: string) =>
  Array.from({ length: branchesRef.current })
)
jest.mock("@/lib/db/sessions", () => ({
  listSessionBranches: (id: string) => listSessionBranches(id),
}))
jest.mock("@/hooks/data", () => {
  const react = jest.requireActual<typeof import("react")>("react")
  return {
    // Resolves the async query the way the live query would, one tick later.
    useClientLiveQuery: <T,>(query: () => Promise<T>, deps: unknown[], initial: T): T => {
      const [value, setValue] = react.useState<T>(initial)
      react.useEffect(() => {
        let alive = true
        void query().then((next) => {
          if (alive) setValue(next)
        })
        return () => {
          alive = false
        }
      }, deps)
      return value
    },
  }
})

import { ConversationDeleteConfirm } from "./conversation-delete-confirm"

const session: ChatSession = {
  id: "s1",
  title: "Daily standup",
  createdAt: 1,
  updatedAt: 1,
  kind: "direct",
}

beforeEach(() => {
  branchesRef.current = 0
  listSessionBranches.mockClear()
})

describe("<ConversationDeleteConfirm />", () => {
  it("asks before deleting, naming the conversation", async () => {
    render(
      <ConversationDeleteConfirm session={session} onCancel={jest.fn()} onConfirm={jest.fn()} />
    )
    const dialog = await screen.findByTestId("conversation-delete-confirm")
    expect(dialog).toHaveTextContent('deleteConfirmTitle:{"title":"Daily standup"}')
    expect(dialog).toHaveTextContent("deleteConfirmBody")
  })

  it("mentions the branches that will be kept", async () => {
    branchesRef.current = 2
    render(
      <ConversationDeleteConfirm session={session} onCancel={jest.fn()} onConfirm={jest.fn()} />
    )
    expect(await screen.findByText(/deleteConfirmBranches:\{"count":2\}/)).toBeInTheDocument()
    expect(listSessionBranches).toHaveBeenCalledWith("s1")
  })

  it("does not query branches while closed", () => {
    render(<ConversationDeleteConfirm session={null} onCancel={jest.fn()} onConfirm={jest.fn()} />)
    expect(screen.queryByTestId("conversation-delete-confirm")).toBeNull()
    expect(listSessionBranches).not.toHaveBeenCalled()
  })

  it("deletes only on the explicit confirm", async () => {
    const user = userEvent.setup()
    const onConfirm = jest.fn()
    render(
      <ConversationDeleteConfirm session={session} onCancel={jest.fn()} onConfirm={onConfirm} />
    )
    await user.click(await screen.findByTestId("conversation-delete-confirm-action"))
    expect(onConfirm).toHaveBeenCalledWith(session)
  })

  it("backs out on cancel", async () => {
    const user = userEvent.setup()
    const onCancel = jest.fn()
    const onConfirm = jest.fn()
    render(
      <ConversationDeleteConfirm session={session} onCancel={onCancel} onConfirm={onConfirm} />
    )
    await user.click(await screen.findByRole("button", { name: "cancel" }))
    expect(onCancel).toHaveBeenCalled()
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it("names an untitled conversation instead of quoting nothing", async () => {
    render(
      <ConversationDeleteConfirm
        session={{ ...session, title: "" }}
        onCancel={jest.fn()}
        onConfirm={jest.fn()}
      />
    )
    expect(await screen.findByTestId("conversation-delete-confirm")).toHaveTextContent(
      'deleteConfirmTitle:{"title":"untitled"}'
    )
  })

  it("names a placeholder-titled conversation in the reader's words", async () => {
    render(
      <ConversationDeleteConfirm
        session={{ ...session, title: "New chat" }}
        onCancel={jest.fn()}
        onConfirm={jest.fn()}
      />
    )
    expect(await screen.findByTestId("conversation-delete-confirm")).toHaveTextContent(
      'deleteConfirmTitle:{"title":"placeholderTitle"}'
    )
  })
})
