/** @jest-environment jsdom */

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"

import {
  conversationTarget,
  mailTarget,
  toReviewTarget,
} from "@/lib/policy/action-review/outbound-targets"
import type { ShadowReportView } from "@/hooks/outbound/use-shadow-report"

const CHAT = conversationTarget("lark:bot-a:oc_1")!
const MAIL = mailTarget("ops@example.com")!

let mockedSettings: Record<string, unknown> = {}
const saveMock = jest.fn(async (_patch: unknown) => undefined)
jest.mock("@/stores/settings", () => ({
  useSettingsStore: (select: (state: unknown) => unknown) =>
    select({ settings: mockedSettings, save: saveMock }),
}))

let remote = false
jest.mock("@/hooks/use-host-profile", () => ({ useRemoteHostActive: () => remote }))

let view: ShadowReportView | undefined
const useShadowReport = jest.fn((_enabled: boolean) => view)
jest.mock("@/hooks/outbound/use-shadow-report", () => ({
  useShadowReport: (enabled: boolean) => useShadowReport(enabled),
}))
jest.mock("@/hooks/bots/use-bot-installations", () => ({
  useBotInstallations: () => ({ rows: [{ id: "boti_1", name: "Reviewer" }] }),
}))

const allowShadowRecipient = jest.fn(async (_into: unknown, _target: unknown) => true)
jest.mock("@/lib/policy/action-review/allow-recipient", () => ({
  allowShadowRecipient: (into: unknown, target: unknown) => allowShadowRecipient(into, target),
}))

const success = jest.fn()
const error = jest.fn()
jest.mock("sonner", () => ({
  toast: { success: (m: string) => success(m), error: (m: string) => error(m) },
}))

import { OutboundAuthorizationCard } from "./outbound-authorization-card"

function reportView(): ShadowReportView {
  return {
    report: {
      groups: [
        {
          sender: { kind: "task", id: "t1" },
          rows: [
            {
              ...toReviewTarget(CHAT),
              target: CHAT,
              sends: 3,
              lastAt: 10,
              outcomes: { draft: 2, park: 1 },
              allowInto: { kind: "adapter", adapterId: "bot-a" },
            },
            {
              ...toReviewTarget(MAIL),
              target: MAIL,
              sends: 1,
              lastAt: 9,
              outcomes: { draft: 1 },
            },
          ],
          unrecognized: [{ channel: "bot-a", recipients: 2, sends: 4, lastAt: 8 }],
          sends: 8,
          lastAt: 10,
        },
        {
          sender: { kind: "bot", id: "boti_1" },
          rows: [
            {
              ...toReviewTarget(MAIL),
              target: MAIL,
              sends: 1,
              lastAt: 5,
              outcomes: { ask: 1 },
              allowInto: { kind: "bot", installationId: "boti_1" },
            },
          ],
          unrecognized: [],
          sends: 1,
          lastAt: 5,
        },
      ],
      totals: { draft: 3, park: 1, ask: 1 },
      sends: 9,
    },
    adapterNames: new Map([["bot-a", "Team bot"]]),
    taskNames: new Map([["t1", "Morning digest"]]),
    conversationTitles: new Map([[CHAT.recipient, "Ops room"]]),
  }
}

beforeEach(() => {
  mockedSettings = { agentPermissions: { subagentAsks: "surface" } }
  remote = false
  view = reportView()
  saveMock.mockClear()
  allowShadowRecipient.mockClear()
  useShadowReport.mockClear()
  success.mockClear()
  error.mockClear()
})

describe("OutboundAuthorizationCard", () => {
  it("labels shadow mode as observing only, and lists what enforcement would hold", () => {
    render(<OutboundAuthorizationCard />)
    expect(screen.getByTestId("outbound-authorization-observe-only")).toHaveTextContent(
      "Observe only"
    )
    expect(screen.getByRole("switch")).not.toBeChecked()
    expect(screen.getByText("Scheduled task: Morning digest")).toBeInTheDocument()
    expect(screen.getByText("Bot: Reviewer")).toBeInTheDocument()
    expect(screen.getByText("Ops room")).toBeInTheDocument()
    expect(screen.getByText("via Team bot")).toBeInTheDocument()
    expect(screen.getByText(/2 would be drafted · 1 would wait for approval/)).toBeInTheDocument()
    expect(screen.getByText("No list can hold this recipient")).toBeInTheDocument()
    expect(screen.getByTestId("outbound-shadow-unrecognized")).toHaveTextContent(
      "2 recipients via Team bot this device cannot name (4 sends)"
    )
  })

  it("allows a recipient into the list the report chose", async () => {
    render(<OutboundAuthorizationCard />)
    fireEvent.click(screen.getByRole("button", { name: "Allow Ops room" }))
    await waitFor(() => expect(allowShadowRecipient).toHaveBeenCalledTimes(1))
    expect(allowShadowRecipient).toHaveBeenCalledWith({ kind: "adapter", adapterId: "bot-a" }, CHAT)
    await waitFor(() => expect(success).toHaveBeenCalledWith("Ops room added to the list"))
    fireEvent.click(screen.getByRole("button", { name: "Allow ops@example.com" }))
    await waitFor(() =>
      expect(allowShadowRecipient).toHaveBeenLastCalledWith(
        { kind: "bot", installationId: "boti_1" },
        MAIL
      )
    )
  })

  it("reports a refused allow", async () => {
    allowShadowRecipient.mockRejectedValueOnce(new Error("gone"))
    render(<OutboundAuthorizationCard />)
    fireEvent.click(screen.getByRole("button", { name: "Allow Ops room" }))
    await waitFor(() => expect(error).toHaveBeenCalledWith("Could not allow the recipient: gone"))
  })

  it("asks before enforcing, naming what it would change, and keeps the other permissions", async () => {
    render(<OutboundAuthorizationCard />)
    fireEvent.click(screen.getByRole("switch"))
    const dialog = await screen.findByRole("alertdialog")
    expect(within(dialog).getByTestId("outbound-authorization-confirm-impact")).toHaveTextContent(
      "9 observed sends would have been changed:"
    )
    expect(within(dialog).getByText("1 asked about")).toBeInTheDocument()
    expect(within(dialog).getByText("3 drafted")).toBeInTheDocument()
    expect(within(dialog).getByText("1 held for approval")).toBeInTheDocument()
    expect(saveMock).not.toHaveBeenCalled()
    fireEvent.click(within(dialog).getByTestId("outbound-authorization-confirm"))
    await waitFor(() =>
      expect(saveMock).toHaveBeenCalledWith({
        agentPermissions: { subagentAsks: "surface", outboundAuthorization: "enforce" },
      })
    )
  })

  it("keeps observing when the confirmation is declined", async () => {
    render(<OutboundAuthorizationCard />)
    fireEvent.click(screen.getByRole("switch"))
    fireEvent.click(await screen.findByRole("button", { name: "Keep observing" }))
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument())
    expect(saveMock).not.toHaveBeenCalled()
  })

  it("returns to shadow mode without asking", async () => {
    mockedSettings = { agentPermissions: { outboundAuthorization: "enforce" } }
    render(<OutboundAuthorizationCard />)
    expect(screen.queryByTestId("outbound-authorization-observe-only")).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("switch"))
    await waitFor(() =>
      expect(saveMock).toHaveBeenCalledWith({
        agentPermissions: { outboundAuthorization: "shadow" },
      })
    )
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument()
  })

  it("says when nothing would change", async () => {
    view = { ...reportView(), report: { groups: [], totals: {}, sends: 0 } }
    render(<OutboundAuthorizationCard />)
    expect(screen.getByTestId("outbound-shadow-report-empty")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("switch"))
    expect(await screen.findByText("No observed send would have been changed.")).toBeInTheDocument()
  })

  it("edits nothing while this shell drives a paired Host", () => {
    remote = true
    render(<OutboundAuthorizationCard />)
    expect(screen.getByTestId("outbound-authorization-remote")).toBeInTheDocument()
    expect(screen.getByRole("switch")).toBeDisabled()
    expect(screen.queryByTestId("outbound-shadow-report")).not.toBeInTheDocument()
    expect(useShadowReport).toHaveBeenLastCalledWith(false)
  })
})
