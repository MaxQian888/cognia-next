/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { act } from "react"
import { NextIntlClientProvider } from "next-intl"
import { useProposalStore } from "@/lib/workflow/editor/proposal-store"

jest.mock("sonner", () => ({
  toast: {
    success: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
    message: jest.fn(),
  },
}))

const applyProposalOps = jest.fn()
jest.mock("@/lib/workflow/editor/store-registry", () => ({
  getEditorStore: jest.fn(),
}))

import { toast } from "sonner"
import { getEditorStore } from "@/lib/workflow/editor/store-registry"
import { StickyProposalBanner } from "./sticky-proposal-banner"

const mGetEditorStore = getEditorStore as jest.Mock
const mApply = applyProposalOps
const mToastInfo = toast.info as jest.Mock
const mToastSuccess = toast.success as jest.Mock

const MESSAGES = {
  workflowEditor: {
    chat: {
      proposal: {
        banner: {
          applyAll: "Apply",
          discard: "Discard",
          revealInChat: "Reveal",
          ops: "{count} ops",
        },
        toast: {
          proposed: "Proposed: {summary}",
          applied: "Applied: {summary}",
          discarded: "Discarded: {summary}",
        },
      },
    },
  },
}

function harness(props: { onRevealInChat?: jest.Mock } = {}) {
  return render(
    <NextIntlClientProvider locale="en" messages={MESSAGES as never}>
      <StickyProposalBanner workflowId="wf_a" onRevealInChat={props.onRevealInChat} />
    </NextIntlClientProvider>
  )
}

function openProposal(workflowId: string, summary: string) {
  return useProposalStore.getState().openProposal(workflowId, {
    proposalId: "p1",
    workflowId,
    summary,
    ops: [{ type: "add_node", nodeId: "n1", kind: "ai.prompt", position: { x: 0, y: 0 } }],
  })
}

beforeEach(() => {
  jest.clearAllMocks()
  mApply.mockReset()
  mGetEditorStore.mockReturnValue({
    getState: () => ({ applyProposalOps: (...args: unknown[]) => mApply(...args) }),
  })
  // Reset store between tests.
  act(() => useProposalStore.setState({ entries: {} }))
})

describe("StickyProposalBanner", () => {
  it("renders nothing when no proposal is open", () => {
    harness()
    expect(screen.queryByTestId("workflow-proposal-banner")).toBeNull()
  })

  it("renders the open proposal summary + actions", () => {
    act(() => {
      openProposal("wf_a", "Add Telegram inbox node")
    })
    harness()
    expect(screen.getByTestId("workflow-proposal-banner")).toHaveTextContent(
      "Add Telegram inbox node"
    )
    expect(screen.getByTestId("workflow-proposal-banner-apply")).toBeInTheDocument()
    expect(screen.getByTestId("workflow-proposal-banner-discard")).toBeInTheDocument()
  })

  it("toasts on the proposed → applied transition and clears the banner", async () => {
    const user = userEvent.setup()
    act(() => {
      openProposal("wf_a", "Add Telegram inbox node")
    })
    mApply.mockReturnValue({ ok: true })
    harness()
    // Initial render fires the proposed toast (info).
    expect(mToastInfo).toHaveBeenCalledTimes(1)
    await user.click(screen.getByTestId("workflow-proposal-banner-apply"))
    expect(mApply).toHaveBeenCalled()
    expect(mToastSuccess).toHaveBeenCalledTimes(1)
    // After apply the banner disappears because `open` is cleared.
    expect(screen.queryByTestId("workflow-proposal-banner")).toBeNull()
  })

  it("discard fires a transition and hides the banner", async () => {
    const user = userEvent.setup()
    act(() => {
      openProposal("wf_a", "Drop the cron node")
    })
    harness()
    await user.click(screen.getByTestId("workflow-proposal-banner-discard"))
    expect(toast.message).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId("workflow-proposal-banner")).toBeNull()
  })

  it("calls onRevealInChat with the proposal id when Reveal is clicked", async () => {
    const user = userEvent.setup()
    const onReveal = jest.fn()
    act(() => {
      openProposal("wf_a", "Add HTTP node")
    })
    harness({ onRevealInChat: onReveal })
    await user.click(screen.getByTestId("workflow-proposal-banner-reveal"))
    expect(onReveal).toHaveBeenCalledWith("p1")
  })
})
