/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { ChatSession } from "@cognia/agent-config-types"

// Identity i18n with var echo so the parent title is assertable.
jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

const getSessionMock = jest.fn(async () => ({ id: "parent", title: "Original plan" }))
jest.mock("@/lib/db/sessions", () => ({
  __esModule: true,
  getSession: (...args: unknown[]) => getSessionMock(...(args as [])),
}))

// `useLiveQuery` needs a live Dexie; resolve the query eagerly instead.
jest.mock("dexie-react-hooks", () => ({
  __esModule: true,
  useLiveQuery: (fn: () => unknown) => {
    const [value, setValue] = jest.requireActual("react").useState(undefined)
    jest.requireActual("react").useEffect(() => {
      void Promise.resolve(fn()).then(setValue)
    }, [])
    return value
  },
}))

import { BranchLineageChip } from "./branch-lineage-chip"
import { useChatStore } from "@/stores/chat"
import { useChatViewportStore } from "@/stores/chat/chat-viewport-store"

function session(extra: Partial<ChatSession> = {}): ChatSession {
  return {
    id: "child",
    title: "Original plan (branch)",
    createdAt: 0,
    updatedAt: 0,
    ...extra,
  } as ChatSession
}

beforeEach(() => {
  jest.clearAllMocks()
  useChatStore.setState({ activeSessionId: "child" })
  useChatViewportStore.setState({ jumpToMessage: null })
})

describe("BranchLineageChip", () => {
  it("renders nothing for a session that is not a branch", () => {
    const { container } = render(<BranchLineageChip session={session()} />)
    expect(container).toBeEmptyDOMElement()
  })

  it("names the parent conversation", async () => {
    render(<BranchLineageChip session={session({ parentSessionId: "parent" })} />)
    expect(await screen.findByText('lineage:{"title":"Original plan"}')).toBeInTheDocument()
  })

  it("falls back to a placeholder when the parent row is gone", async () => {
    getSessionMock.mockResolvedValue(null as never)
    render(<BranchLineageChip session={session({ parentSessionId: "parent" })} />)
    expect(await screen.findByText('lineage:{"title":"lineageUnknownParent"}')).toBeInTheDocument()
  })

  it("activates the parent and lands on the branch point", async () => {
    const jumpToMessage = jest.fn(() => true)
    useChatViewportStore.setState({ jumpToMessage })
    render(
      <BranchLineageChip
        session={session({ parentSessionId: "parent", branchedFromMessageId: "m7" })}
      />
    )
    fireEvent.click(screen.getByTestId("branch-lineage-chip"))
    expect(useChatStore.getState().activeSessionId).toBe("parent")
    // The jump is deferred to the next frame so it runs against the parent's
    // freshly-mounted message list.
    await waitFor(() => expect(jumpToMessage).toHaveBeenCalledWith("m7"))
  })

  it("still switches sessions when the branch point was never recorded", async () => {
    const jumpToMessage = jest.fn(() => true)
    useChatViewportStore.setState({ jumpToMessage })
    render(<BranchLineageChip session={session({ parentSessionId: "parent" })} />)
    fireEvent.click(screen.getByTestId("branch-lineage-chip"))
    expect(useChatStore.getState().activeSessionId).toBe("parent")
    await waitFor(() => expect(jumpToMessage).not.toHaveBeenCalled())
  })
})
