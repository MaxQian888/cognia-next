import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import messages from "@/i18n/messages/en.json"

// Each source is stubbed down to a marker so these tests pin the AREA's
// contract — count, disclosure, per-source mobile suppression — rather than
// re-testing five presenters that own their own suites.
jest.mock("../connection-loss-banner", () => ({
  ConnectionLossNotice: () => <div data-testid="src-connection-loss" />,
}))
jest.mock("../outbound-saturation-banner", () => ({
  OutboundSaturationNotice: () => <div data-testid="src-outbound-saturation" />,
}))
jest.mock("../inbound-recovery-panel", () => ({
  InboundRecoveryNotice: () => <div data-testid="src-inbound-recovery" />,
}))
jest.mock("../draft-banner", () => ({
  DraftNotice: () => <div data-testid="src-draft" />,
}))
jest.mock("../conversation-activity-log", () => ({
  ConversationActivityNotice: () => <div data-testid="src-activity" />,
}))

const mockDismissDegraded = jest.fn()
const mockDismissSaturation = jest.fn()
let degradedAdapters: unknown[] = []
let saturatedAdapters: unknown[] = []
let recoveryJobs: unknown[] = []
let pendingDrafts: unknown[] = []
let auditEntries: unknown[] = []
let assignmentEvents: unknown[] = []

jest.mock("@/hooks/connectors/use-degraded-adapters", () => ({
  useDegradedAdapters: () => ({ adapters: degradedAdapters, dismiss: mockDismissDegraded }),
}))
jest.mock("@/hooks/connectors/use-outbound-saturation", () => ({
  useOutboundSaturation: () => ({ adapters: saturatedAdapters, dismiss: mockDismissSaturation }),
}))
jest.mock("@/hooks/connectors/use-inbound-recovery-jobs", () => ({
  useInboundRecoveryJobs: () => recoveryJobs,
}))
jest.mock("@/hooks/connectors/use-pending-drafts", () => ({
  usePendingDraftsForConversation: () => pendingDrafts,
}))
jest.mock("@/hooks/connectors/use-conversation-activity", () => ({
  useConversationActivity: () => auditEntries,
}))
jest.mock("@/hooks/connectors/use-conversation-assignment-events", () => ({
  useConversationAssignmentEvents: () => assignmentEvents,
}))

let isMobile = false
jest.mock("@/hooks/ui/use-mobile", () => ({ useIsMobile: () => isMobile }))

import { InboxNoticeArea } from "./notice-area"

function renderArea(conversationKey?: string) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <InboxNoticeArea conversationKey={conversationKey} />
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  isMobile = false
  degradedAdapters = []
  saturatedAdapters = []
  recoveryJobs = []
  pendingDrafts = []
  auditEntries = []
  assignmentEvents = []
  jest.clearAllMocks()
})

describe("InboxNoticeArea", () => {
  it("renders nothing when every source is quiet", () => {
    renderArea("ck")
    expect(screen.queryByTestId("inbox-notice-area")).not.toBeInTheDocument()
  })

  it("renders a single notice with no disclosure chrome", () => {
    degradedAdapters = [{ adapterId: "a" }]
    renderArea("ck")
    expect(screen.getByTestId("inbox-notice-area")).toHaveAttribute("data-notice-count", "1")
    expect(screen.getByTestId("src-connection-loss")).toBeInTheDocument()
    // "1 notice ▸" over a single row is pure chrome.
    expect(screen.queryByTestId("inbox-notice-toggle")).not.toBeInTheDocument()
  })

  it("collapses behind a summary once there is more than one", async () => {
    degradedAdapters = [{ adapterId: "a" }]
    pendingDrafts = [{ id: "d1" }]
    renderArea("ck")

    const area = screen.getByTestId("inbox-notice-area")
    expect(area).toHaveAttribute("data-notice-count", "2")
    const toggle = screen.getByTestId("inbox-notice-toggle")
    expect(toggle).toHaveTextContent("2 notices")
    expect(toggle).toHaveAttribute("aria-expanded", "false")

    await userEvent.click(toggle)
    expect(screen.getByTestId("inbox-notice-toggle")).toHaveAttribute("aria-expanded", "true")
  })

  // Unmounting would tear down the Sheet the draft notice owns mid-review.
  it("keeps the rows mounted while collapsed", () => {
    degradedAdapters = [{ adapterId: "a" }]
    pendingDrafts = [{ id: "d1" }]
    renderArea("ck")
    expect(screen.getByTestId("src-draft")).toBeInTheDocument()
  })

  it("counts each source that has content", () => {
    degradedAdapters = [{ adapterId: "a" }]
    saturatedAdapters = [{ adapterId: "b" }]
    recoveryJobs = [{ id: "j" }]
    pendingDrafts = [{ id: "d" }]
    auditEntries = [{ id: "e" }]
    renderArea("ck")
    expect(screen.getByTestId("inbox-notice-area")).toHaveAttribute("data-notice-count", "5")
  })

  it("counts activity when only the assignment trail has rows", () => {
    assignmentEvents = [{ id: "a1" }]
    renderArea("ck")
    expect(screen.getByTestId("src-activity")).toBeInTheDocument()
  })

  // The list routes mount the area too, but have no conversation in view.
  it("omits conversation-scoped sources without a conversation key", () => {
    degradedAdapters = [{ adapterId: "a" }]
    pendingDrafts = [{ id: "d1" }]
    recoveryJobs = [{ id: "j1" }]
    auditEntries = [{ id: "e1" }]
    renderArea(undefined)

    expect(screen.getByTestId("inbox-notice-area")).toHaveAttribute("data-notice-count", "1")
    expect(screen.queryByTestId("src-draft")).not.toBeInTheDocument()
    expect(screen.queryByTestId("src-inbound-recovery")).not.toBeInTheDocument()
    expect(screen.queryByTestId("src-activity")).not.toBeInTheDocument()
  })

  // Adapter-level notices duplicate signals the list rows already carry, but a
  // pending draft has no other entry point in the single-pane mobile stack.
  it("hides only the adapter-level notices on mobile", () => {
    degradedAdapters = [{ adapterId: "a" }]
    saturatedAdapters = [{ adapterId: "b" }]
    pendingDrafts = [{ id: "d1" }]
    renderArea("ck")

    expect(screen.getByTestId("src-connection-loss").parentElement).toHaveClass(
      "hidden",
      "md:block"
    )
    expect(screen.getByTestId("src-outbound-saturation").parentElement).toHaveClass(
      "hidden",
      "md:block"
    )
    expect(screen.getByTestId("src-draft").parentElement).not.toHaveClass("hidden")
  })

  // The CSS class alone hid the rows but left the bordered band, the count and
  // the disclosure behind — a phone showed an empty strip claiming "2 notices".
  it("renders nothing on a phone when only adapter-level sources are live", () => {
    isMobile = true
    degradedAdapters = [{ adapterId: "a" }]
    saturatedAdapters = [{ adapterId: "b" }]
    renderArea("ck")
    expect(screen.queryByTestId("inbox-notice-area")).not.toBeInTheDocument()
  })

  it("counts only what a phone can see", () => {
    isMobile = true
    degradedAdapters = [{ adapterId: "a" }]
    saturatedAdapters = [{ adapterId: "b" }]
    pendingDrafts = [{ id: "d1" }]
    renderArea("ck")

    expect(screen.getByTestId("inbox-notice-area")).toHaveAttribute("data-notice-count", "1")
    // One visible notice needs no disclosure chrome.
    expect(screen.queryByTestId("inbox-notice-toggle")).not.toBeInTheDocument()
    expect(screen.getByTestId("src-draft")).toBeInTheDocument()
    expect(screen.queryByTestId("src-connection-loss")).not.toBeInTheDocument()
    expect(screen.queryByTestId("src-outbound-saturation")).not.toBeInTheDocument()
  })

  it("summarizes only the phone-visible notices", () => {
    isMobile = true
    degradedAdapters = [{ adapterId: "a" }]
    pendingDrafts = [{ id: "d1" }]
    recoveryJobs = [{ id: "j1" }]
    renderArea("ck")

    expect(screen.getByTestId("inbox-notice-area")).toHaveAttribute("data-notice-count", "2")
    expect(screen.getByTestId("inbox-notice-toggle")).toHaveTextContent("2 notices")
  })

  it("labels itself as a region for assistive tech", () => {
    degradedAdapters = [{ adapterId: "a" }]
    renderArea("ck")
    expect(screen.getByRole("region", { name: "Inbox notices" })).toBeInTheDocument()
  })
})
