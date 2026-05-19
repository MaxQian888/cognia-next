/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"

jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: jest.fn(),
}))

jest.mock("@/lib/workflow/editor/proposal-history", () => ({
  PROPOSAL_HISTORY_LIMIT: 50,
  listProposalHistory: jest.fn(),
}))

import { useLiveQuery } from "dexie-react-hooks"
import { ChangelogTab } from "./changelog-tab"

const mLive = useLiveQuery as jest.Mock

const MESSAGES = {
  workflowEditor: {
    chat: {
      changelog: {
        noWorkflow: "Open a workflow to see history.",
        loading: "Loading…",
        empty: "No changes recorded yet.",
        reveal: "Reveal",
        openSnapshot: "Focus",
        opsCount: "{count} ops",
        status: {
          applied: "Applied",
          discarded: "Discarded",
        },
      },
    },
  },
}

const setSelectedNodes = jest.fn()
const focusViewport = jest.fn()

function fakeStore() {
  return {
    getState: () => ({
      setSelectedNodes,
      focusViewport,
    }),
  } as never
}

function harness(rows: unknown, opts: { workflowId?: string; onReveal?: jest.Mock } = {}) {
  mLive.mockReturnValue(rows)
  return render(
    <NextIntlClientProvider
      locale="en"
      messages={MESSAGES as never}
      timeZone="UTC"
      now={new Date(0)}
    >
      <ChangelogTab
        workflowId={opts.workflowId ?? "wf_a"}
        useStore={fakeStore()}
        onRevealInChat={opts.onReveal}
      />
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  jest.clearAllMocks()
})

describe("ChangelogTab", () => {
  it("renders the no-workflow placeholder", () => {
    harness([], { workflowId: undefined as never })
    expect(screen.getByTestId("workflow-changelog-empty")).toBeInTheDocument()
    // The empty rendering path returns the "no workflow" placeholder when
    // workflowId is undefined; row container is absent.
    expect(screen.queryByTestId("workflow-changelog")).toBeNull()
  })

  it("renders the loading placeholder when useLiveQuery returns undefined", () => {
    harness(undefined)
    expect(screen.getByTestId("workflow-changelog-loading")).toBeInTheDocument()
  })

  it("renders the empty placeholder when no history rows", () => {
    harness([])
    expect(screen.getByTestId("workflow-changelog-empty")).toBeInTheDocument()
    // No rows mounted when history is empty.
    expect(screen.queryByTestId("workflow-changelog")).toBeNull()
  })

  it("renders each history row with status badge + summary + actions", () => {
    harness([
      {
        id: "p1:applied",
        workflowId: "wf_a",
        proposalId: "p1",
        status: "applied",
        summary: "Add Telegram trigger",
        opsCount: 3,
        affectedNodeIds: ["n1", "n2"],
        messageId: "m1",
        createdAt: Date.now(),
      },
      {
        id: "p2:discarded",
        workflowId: "wf_a",
        proposalId: "p2",
        status: "discarded",
        summary: "Drop cron",
        opsCount: 1,
        affectedNodeIds: ["n3"],
        createdAt: Date.now() - 60_000,
      },
    ])
    expect(screen.getByTestId("workflow-changelog")).toBeInTheDocument()
    expect(screen.getByTestId("workflow-changelog-row-p1:applied")).toHaveAttribute(
      "data-status",
      "applied"
    )
    expect(screen.getByTestId("workflow-changelog-row-p1:applied")).toHaveTextContent(
      "Add Telegram trigger"
    )
    expect(screen.getByTestId("workflow-changelog-row-p2:discarded")).toHaveAttribute(
      "data-status",
      "discarded"
    )
    expect(screen.getByTestId("workflow-changelog-row-p2:discarded")).toHaveTextContent("Drop cron")
  })

  it("calls onRevealInChat with messageId + proposalId", async () => {
    const user = userEvent.setup()
    const onReveal = jest.fn()
    harness(
      [
        {
          id: "p1:applied",
          workflowId: "wf_a",
          proposalId: "p1",
          status: "applied",
          summary: "Add HTTP",
          opsCount: 1,
          affectedNodeIds: ["n1"],
          messageId: "msg_1",
          createdAt: 0,
        },
      ],
      { onReveal }
    )
    await user.click(screen.getByTestId("workflow-changelog-reveal-p1:applied"))
    expect(onReveal).toHaveBeenCalledWith("msg_1", "p1")
  })

  it("focuses the affected nodes when Open Snapshot is clicked", async () => {
    const user = userEvent.setup()
    harness([
      {
        id: "p1:applied",
        workflowId: "wf_a",
        proposalId: "p1",
        status: "applied",
        summary: "Wrap retry",
        opsCount: 2,
        affectedNodeIds: ["n1", "n2"],
        createdAt: 0,
      },
    ])
    await user.click(screen.getByTestId("workflow-changelog-snapshot-p1:applied"))
    expect(setSelectedNodes).toHaveBeenCalledWith(["n1", "n2"])
    expect(focusViewport).toHaveBeenCalledWith(["n1", "n2"])
  })
})
