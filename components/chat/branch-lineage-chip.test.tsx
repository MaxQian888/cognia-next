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

// The cross-session wait has its own suite (`lib/chat/cross-session-jump.test.ts`);
// here we only care that the chip delegates to it and reports a miss.
const jumpToSessionMessageMock = jest.fn(async () => true)
jest.mock("@/lib/chat/cross-session-jump", () => ({
  __esModule: true,
  jumpToSessionMessage: (...args: unknown[]) => jumpToSessionMessageMock(...(args as [])),
}))

const toastErrorMock = jest.fn()
jest.mock("sonner", () => ({ toast: { error: (...args: unknown[]) => toastErrorMock(...args) } }))

import { BranchLineageChip } from "./branch-lineage-chip"
import { useChatStore } from "@/stores/chat"

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
  jumpToSessionMessageMock.mockResolvedValue(true)
  useChatStore.setState({ activeSessionId: "child" })
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

  it("lands on the branch point through the hydration-aware jump", async () => {
    // Not one animation frame: the parent's history may not have loaded, and a
    // jump fired before it does reports a miss for a message that exists.
    render(
      <BranchLineageChip
        session={session({ parentSessionId: "parent", branchedFromMessageId: "m7" })}
      />
    )
    fireEvent.click(screen.getByTestId("branch-lineage-chip"))
    await waitFor(() =>
      expect(jumpToSessionMessageMock).toHaveBeenCalledWith("parent", "m7", { align: "center" })
    )
    expect(toastErrorMock).not.toHaveBeenCalled()
  })

  it("says so when the branch point is no longer in the parent", async () => {
    jumpToSessionMessageMock.mockResolvedValue(false)
    render(
      <BranchLineageChip
        session={session({ parentSessionId: "parent", branchedFromMessageId: "m7" })}
      />
    )
    fireEvent.click(screen.getByTestId("branch-lineage-chip"))
    await waitFor(() => expect(toastErrorMock).toHaveBeenCalledWith("lineageAnchorMissing"))
  })

  it("still switches sessions when the branch point was never recorded", async () => {
    render(<BranchLineageChip session={session({ parentSessionId: "parent" })} />)
    fireEvent.click(screen.getByTestId("branch-lineage-chip"))
    expect(useChatStore.getState().activeSessionId).toBe("parent")
    await waitFor(() => expect(jumpToSessionMessageMock).not.toHaveBeenCalled())
  })

  it("names a deleted parent in the accessible name too, not only the label", () => {
    // The visible label fell back correctly while the aria-label degraded to
    // "…created from, in " — one resolved title now feeds both.
    getSessionMock.mockResolvedValue(null as never)
    render(<BranchLineageChip session={session({ parentSessionId: "parent" })} />)
    expect(screen.getByTestId("branch-lineage-chip")).toHaveAttribute(
      "aria-label",
      'ariaLineage:{"title":"lineageUnknownParent"}'
    )
  })
})
