/** @jest-environment jsdom */

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"

import {
  conversationTarget,
  mailTarget,
  repositoryTarget,
  toReviewTarget,
} from "@/lib/policy/action-review/outbound-targets"
import type { ShadowReportView } from "@/hooks/outbound/use-shadow-report"

const CHAT = conversationTarget("lark:bot-a:oc_1")!
const MAIL = mailTarget("ops@example.com")!
const WEB = repositoryTarget("acme/web")!
const API = repositoryTarget("acme/api")!
const EMPTY = { groups: [], totals: {}, sends: 0 }

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
      messaging: messagingReport(),
      github: githubReport(),
      browser: EMPTY,
    },
    adapterNames: new Map([["bot-a", "Team bot"]]),
    taskNames: new Map([["t1", "Morning digest"]]),
    conversationTitles: new Map([[CHAT.recipient, "Ops room"]]),
    accountNames: new Map([
      ["acct_1", "Work"],
      ["acct_2", "Personal"],
    ]),
    teamNames: new Map([["team_1", "Release squad"]]),
  }
}

function githubReport(): ShadowReportView["report"]["github"] {
  return {
    groups: [
      {
        sender: { kind: "workflow", id: "wf_1" },
        rows: [
          {
            ...toReviewTarget(WEB),
            target: WEB,
            sends: 2,
            lastAt: 20,
            outcomes: { park: 2 },
            allowInto: {
              kind: "integration-account",
              pluginId: "github-delivery",
              accountId: "acct_1",
            },
          },
        ],
        unrecognized: [{ channel: "github", recipients: 2, sends: 3, lastAt: 18 }],
        sends: 5,
        lastAt: 20,
      },
      {
        sender: { kind: "team", id: "team_1" },
        rows: [
          {
            ...toReviewTarget(API),
            target: API,
            sends: 1,
            lastAt: 15,
            outcomes: { park: 1 },
            allowChoices: [
              { kind: "integration-account", pluginId: "github-delivery", accountId: "acct_1" },
              { kind: "integration-account", pluginId: "github-delivery", accountId: "acct_2" },
            ],
          },
        ],
        unrecognized: [],
        sends: 1,
        lastAt: 15,
      },
    ],
    totals: { park: 6 },
    sends: 6,
  }
}

function messagingReport(): ShadowReportView["report"]["messaging"] {
  return {
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
  }
}

const messaging = () => within(screen.getByTestId("outbound-authorization-messaging"))
const github = () => within(screen.getByTestId("outbound-authorization-github"))

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
    expect(screen.getByTestId("outbound-authorization-observe-only-messaging")).toHaveTextContent(
      "Observe only"
    )
    expect(messaging().getByRole("switch")).not.toBeChecked()
    expect(screen.getByText("Scheduled task: Morning digest")).toBeInTheDocument()
    expect(screen.getByText("Bot: Reviewer")).toBeInTheDocument()
    expect(screen.getByText("Ops room")).toBeInTheDocument()
    expect(screen.getByText("via Team bot")).toBeInTheDocument()
    expect(screen.getByText(/2 would be drafted · 1 would wait for approval/)).toBeInTheDocument()
    expect(screen.getByText("No list can hold this recipient")).toBeInTheDocument()
    expect(messaging().getByTestId("outbound-shadow-unrecognized")).toHaveTextContent(
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
    fireEvent.click(messaging().getByRole("switch"))
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
    fireEvent.click(messaging().getByRole("switch"))
    fireEvent.click(await screen.findByRole("button", { name: "Keep observing" }))
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument())
    expect(saveMock).not.toHaveBeenCalled()
  })

  it("returns to shadow mode without asking", async () => {
    mockedSettings = { agentPermissions: { outboundAuthorization: "enforce" } }
    render(<OutboundAuthorizationCard />)
    expect(
      screen.queryByTestId("outbound-authorization-observe-only-messaging")
    ).not.toBeInTheDocument()
    // GitHub keeps its own mode.
    expect(screen.getByTestId("outbound-authorization-observe-only-github")).toBeInTheDocument()
    fireEvent.click(messaging().getByRole("switch"))
    await waitFor(() =>
      expect(saveMock).toHaveBeenCalledWith({
        agentPermissions: { outboundAuthorization: "shadow" },
      })
    )
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument()
  })

  it("says when nothing would change", async () => {
    view = { ...reportView(), report: { messaging: EMPTY, github: EMPTY, browser: EMPTY } }
    render(<OutboundAuthorizationCard />)
    expect(screen.getByTestId("outbound-shadow-report-empty-messaging")).toBeInTheDocument()
    expect(screen.getByTestId("outbound-shadow-report-empty-github")).toBeInTheDocument()
    fireEvent.click(messaging().getByRole("switch"))
    expect(await screen.findByText("No observed send would have been changed.")).toBeInTheDocument()
  })

  it("edits nothing while this shell drives a paired Host", () => {
    remote = true
    render(<OutboundAuthorizationCard />)
    expect(screen.getByTestId("outbound-authorization-remote")).toBeInTheDocument()
    for (const toggle of screen.getAllByRole("switch")) expect(toggle).toBeDisabled()
    expect(screen.queryByTestId("outbound-shadow-report-messaging")).not.toBeInTheDocument()
    expect(screen.queryByTestId("outbound-shadow-report-github")).not.toBeInTheDocument()
    expect(useShadowReport).toHaveBeenLastCalledWith(false)
    // The site list lives on the Host too, so it is read-only here as well.
    expect(screen.getByLabelText("https://example.com")).toBeDisabled()
  })

  it("has a switch per category, and none for browser submissions yet", () => {
    render(<OutboundAuthorizationCard />)
    expect(screen.getAllByRole("switch")).toHaveLength(2)
    expect(screen.getByText("Enforce for messages and email")).toBeInTheDocument()
    expect(screen.getByText("Enforce for GitHub writes")).toBeInTheDocument()
    expect(screen.queryByTestId("outbound-authorization-browser")).not.toBeInTheDocument()
    // The browser's site list is editable already, labeled as not yet in effect.
    expect(screen.getByTestId("outbound-site-list-dormant")).toBeInTheDocument()
    expect(screen.getByLabelText("https://example.com")).toBeEnabled()
  })

  it("lists GitHub writes in their own report, by sender and repository", () => {
    render(<OutboundAuthorizationCard />)
    expect(github().getByText("Workflow: wf_1")).toBeInTheDocument()
    expect(github().getByText("Agent Team: Release squad")).toBeInTheDocument()
    expect(github().getByText("acme/web")).toBeInTheDocument()
    expect(github().getByText("Adds to the Work account's list")).toBeInTheDocument()
    expect(github().getByTestId("outbound-shadow-unrecognized")).toHaveTextContent(
      "2 repositories this device cannot name (3 writes)"
    )
    // No GitHub row shows in the messaging report.
    expect(messaging().queryByText("acme/web")).not.toBeInTheDocument()
  })

  it("allows a repository into the account the write went through, or the one picked", async () => {
    render(<OutboundAuthorizationCard />)
    fireEvent.click(github().getByRole("button", { name: "Allow acme/web" }))
    await waitFor(() =>
      expect(allowShadowRecipient).toHaveBeenCalledWith(
        { kind: "integration-account", pluginId: "github-delivery", accountId: "acct_1" },
        WEB
      )
    )
    expect(github().getByText("The write named no account. Add to:")).toBeInTheDocument()
    fireEvent.click(github().getByRole("button", { name: "Allow acme/api on Personal" }))
    await waitFor(() =>
      expect(allowShadowRecipient).toHaveBeenLastCalledWith(
        { kind: "integration-account", pluginId: "github-delivery", accountId: "acct_2" },
        API
      )
    )
  })

  it("asks before enforcing GitHub, counting only GitHub writes, and leaves messaging alone", async () => {
    render(<OutboundAuthorizationCard />)
    fireEvent.click(github().getByRole("switch"))
    const dialog = await screen.findByRole("alertdialog")
    expect(
      within(dialog).getByText("Enforce outbound authorization for GitHub writes?")
    ).toBeInTheDocument()
    expect(within(dialog).getByTestId("outbound-authorization-confirm-impact")).toHaveTextContent(
      "6 observed sends would have been changed:"
    )
    expect(within(dialog).getByText("6 held for approval")).toBeInTheDocument()
    fireEvent.click(within(dialog).getByTestId("outbound-authorization-confirm"))
    await waitFor(() =>
      expect(saveMock).toHaveBeenCalledWith({
        agentPermissions: {
          subagentAsks: "surface",
          outboundAuthorizationByCategory: { github: "enforce" },
        },
      })
    )
  })

  it("returns GitHub to shadow mode without asking, keeping the other categories", async () => {
    mockedSettings = {
      agentPermissions: {
        outboundAuthorization: "enforce",
        outboundAuthorizationByCategory: { github: "enforce", browser: "shadow" },
      },
    }
    render(<OutboundAuthorizationCard />)
    expect(
      screen.queryByTestId("outbound-authorization-observe-only-github")
    ).not.toBeInTheDocument()
    fireEvent.click(github().getByRole("switch"))
    await waitFor(() =>
      expect(saveMock).toHaveBeenCalledWith({
        agentPermissions: {
          outboundAuthorization: "enforce",
          outboundAuthorizationByCategory: { github: "shadow", browser: "shadow" },
        },
      })
    )
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument()
  })
})
