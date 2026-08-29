/** @jest-environment jsdom */
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import type { ChatSession } from "@cognia/agent-config-types"
import { BranchChildrenChip, BranchPointMarker } from "./branch-children-chip"

let branches: ChatSession[] = []
jest.mock("dexie-react-hooks", () => ({
  // The component passes an async selector; resolve it synchronously against
  // the fixture so the chip renders in one pass.
  useLiveQuery: (fn: () => unknown) => {
    const out = fn()
    return out instanceof Promise ? undefined : out
  },
}))

jest.mock("@/lib/db/sessions", () => ({
  listSessionBranches: jest.fn(() => branches),
}))

const openSession = jest.fn()
const setActiveSession = jest.fn()
jest.mock("@/stores/chat", () => ({
  useChatStore: { getState: () => ({ openSession, setActiveSession }) },
}))

const messages = {
  chat: {
    branch: {
      childCount: "{count, plural, =1 {1 branch} other {# branches}}",
      childListLabel: "Branches from here",
      pointCount: "{count, plural, =1 {1 branch from here} other {# branches from here}}",
    },
  },
}

const branch = (id: string, title: string, createdAt: number, at?: string): ChatSession =>
  ({
    id,
    title,
    kind: "direct",
    parentSessionId: "parent-1",
    branchedFromMessageId: at,
    createdAt,
    updatedAt: createdAt,
  }) as ChatSession

const wrap = (ui: React.ReactNode) =>
  render(
    <NextIntlClientProvider locale="en" messages={messages}>
      {ui}
    </NextIntlClientProvider>
  )

beforeEach(() => {
  jest.clearAllMocks()
  branches = []
})

describe("BranchChildrenChip", () => {
  it("renders nothing for a conversation that has never been branched", () => {
    const { container } = wrap(<BranchChildrenChip sessionId="parent-1" />)
    expect(container.firstChild).toBeNull()
  })

  it("counts the branches taken from this conversation", () => {
    // The reverse of the lineage chip: a parent used to have no idea it had
    // been branched, so an explored conversation looked like an untouched one.
    branches = [branch("b1", "Plan (branch)", 2), branch("b2", "Plan (branch 2)", 3)]
    wrap(<BranchChildrenChip sessionId="parent-1" />)
    expect(screen.getByTestId("branch-children-chip")).toHaveTextContent("2 branches")
  })

  it("does not present imported subagents or attached background work as branches", () => {
    branches = [
      branch("b1", "Plan (branch)", 2),
      {
        ...branch("subagent", "Explore", 3),
        kind: "subagent",
        importRelation: { kind: "subagent", parentCanonicalSessionId: "parent-1" },
      },
      {
        ...branch("background", "Build", 4),
        visibility: "embedded",
        importRelation: { kind: "background", parentCanonicalSessionId: "parent-1" },
      },
    ]

    wrap(<BranchChildrenChip sessionId="parent-1" />)

    expect(screen.getByTestId("branch-children-chip")).toHaveTextContent("1 branch")
  })

  it("opens the picked branch as a conversation", async () => {
    const user = userEvent.setup()
    branches = [branch("b1", "Plan (branch)", 2)]
    wrap(<BranchChildrenChip sessionId="parent-1" />)

    await user.click(screen.getByTestId("branch-children-chip"))
    await user.click(await screen.findByRole("menuitem", { name: "Plan (branch)" }))

    expect(openSession).toHaveBeenCalledWith("b1")
    expect(setActiveSession).toHaveBeenCalledWith("b1")
  })
})

describe("BranchPointMarker", () => {
  it("renders nothing on a message nothing was branched at", () => {
    branches = [branch("b1", "Plan (branch)", 2, "other-message")]
    const { container } = wrap(<BranchPointMarker sessionId="parent-1" messageId="m1" />)
    expect(container.firstChild).toBeNull()
  })

  it("counts only the branches cut at THIS message", () => {
    branches = [branch("b1", "A", 2, "m1"), branch("b2", "B", 3, "m1"), branch("b3", "C", 4, "m2")]
    wrap(<BranchPointMarker sessionId="parent-1" messageId="m1" />)
    expect(screen.getByTestId("branch-point-marker")).toHaveTextContent("2 branches from here")
  })

  it("ignores non-branch children at a matching message", () => {
    branches = [
      branch("b1", "A", 2, "m1"),
      {
        ...branch("worker", "Worker", 3, "m1"),
        importRelation: { kind: "team-member", parentCanonicalSessionId: "parent-1" },
      },
    ]
    wrap(<BranchPointMarker sessionId="parent-1" messageId="m1" />)
    expect(screen.getByTestId("branch-point-marker")).toHaveTextContent("1 branch from here")
  })

  it("jumps into the most recent branch cut here", async () => {
    const user = userEvent.setup()
    // `listSessionBranches` returns newest first; the marker takes the head.
    branches = [branch("newest", "B", 3, "m1"), branch("older", "A", 2, "m1")]
    wrap(<BranchPointMarker sessionId="parent-1" messageId="m1" />)

    await user.click(screen.getByTestId("branch-point-marker"))
    await waitFor(() => expect(setActiveSession).toHaveBeenCalledWith("newest"))
  })
})
