/** @jest-environment jsdom */

import "fake-indexeddb/auto"
import { render, screen } from "@testing-library/react"

jest.mock("next-intl", () => ({
  useTranslations: () => {
    const t = (key: string, values?: Record<string, unknown>) =>
      values ? `${key}:${Object.values(values).join("/")}` : key
    t.has = () => true
    return t
  },
}))

import enWorkspace from "@/i18n/messages/en/workspace.json"
import zhWorkspace from "@/i18n/messages/zh-CN/workspace.json"

import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import { replaceCollabPlans } from "@/lib/db/collab-plan-mirror"
import { replaceCollabRuns } from "@/lib/db/collab-run-mirror"
import { PLAN_STATUSES_FOR_TEST, RUN_STATUSES_FOR_TEST } from "./workspace-activity-catalogue"
import { WorkspaceActivity } from "./workspace-activity"

const ORG = "org_acme"
const WORKSPACE = "proj_1"
const ADA = "usr_aaaaaaaaaaaaaaaaaaaaaaaa"

type WorkspaceMessages = { activity: Record<string, unknown> }

const labels = (messages: WorkspaceMessages, group: string): Record<string, string> =>
  messages.activity[group] as Record<string, string>

const planLabels = (m: WorkspaceMessages) => labels(m, "planStatus")
const runStatusLabels = (m: WorkspaceMessages) => labels(m, "runStatus")
const runKindLabels = (m: WorkspaceMessages) => labels(m, "runKind")

describe("WorkspaceActivity", () => {
  beforeEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
  })
  afterEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
  })

  it("renders nothing at all without a workspace", () => {
    const { container } = render(<WorkspaceActivity workspaceId={null} />)
    expect(container).toBeEmptyDOMElement()
  })

  it("says a workspace with no shared work is empty, not broken", async () => {
    render(<WorkspaceActivity workspaceId={WORKSPACE} />)
    expect(await screen.findByTestId("workspace-activity-empty")).toBeInTheDocument()
  })

  it("shows a plan's progress as counts, because the steps are not mirrored", async () => {
    await replaceCollabPlans(ORG, [
      {
        id: "plan_1",
        orgId: ORG,
        workspaceId: WORKSPACE,
        title: "Migrate the store",
        status: "executing",
        totalSteps: 3,
        completedSteps: 1,
        createdBy: { kind: "human", id: ADA },
        createdAt: 1,
        updatedAt: 2,
        fetchedAt: 3,
      },
    ])

    render(<WorkspaceActivity workspaceId={WORKSPACE} />)
    expect(await screen.findByTestId("workspace-activity-plan-plan_1")).toBeInTheDocument()
    expect(screen.getByText("Migrate the store")).toBeInTheDocument()
    expect(screen.getByText("progress:1/3")).toBeInTheDocument()
    expect(screen.getByText("planStatus.executing")).toBeInTheDocument()
  })

  it("says a plan with no steps has none rather than showing 0 of 0", async () => {
    await replaceCollabPlans(ORG, [
      {
        id: "plan_empty",
        orgId: ORG,
        workspaceId: WORKSPACE,
        title: "Nothing yet",
        status: "draft",
        totalSteps: 0,
        completedSteps: 0,
        createdBy: { kind: "human", id: ADA },
        createdAt: 1,
        updatedAt: 2,
        fetchedAt: 3,
      },
    ])

    render(<WorkspaceActivity workspaceId={WORKSPACE} />)
    expect(await screen.findByText("noSteps")).toBeInTheDocument()
  })

  it("links a run's artifacts and names who started it", async () => {
    await replaceCollabRuns(ORG, [
      {
        id: "run_1",
        orgId: ORG,
        workspaceId: WORKSPACE,
        issueId: "iss_1",
        title: "Fix the flake",
        kind: "agent-task",
        status: "running",
        startedBy: { kind: "human", id: ADA, label: "Ada" },
        startedAt: 10,
        updatedAt: 10,
        artifacts: [{ label: "PR #12", href: "https://example.com/pr/12" }],
        fetchedAt: 20,
      },
    ])

    render(<WorkspaceActivity workspaceId={WORKSPACE} />)
    const row = await screen.findByTestId("workspace-activity-run-run_1")
    // The line is several text nodes (name · kind), so match the row.
    expect(row).toHaveTextContent("startedBy:Ada")
    const link = screen.getByRole("link", { name: /PR #12/ })
    expect(link).toHaveAttribute("href", "https://example.com/pr/12")
    // Opening somebody else's link must not hand the target a window handle.
    expect(link).toHaveAttribute("rel", expect.stringContaining("noopener"))
  })

  it("falls back to the raw usr_ id when nobody cached a name", async () => {
    // An id somebody can search for beats "unknown person".
    await replaceCollabRuns(ORG, [
      {
        id: "run_2",
        orgId: ORG,
        workspaceId: WORKSPACE,
        title: "Ad-hoc sweep",
        kind: "plan",
        status: "queued",
        startedBy: { kind: "human", id: ADA },
        startedAt: 10,
        updatedAt: 10,
        artifacts: [],
        fetchedAt: 20,
      },
    ])

    render(<WorkspaceActivity workspaceId={WORKSPACE} />)
    const row = await screen.findByTestId("workspace-activity-run-run_2")
    expect(row).toHaveTextContent(`startedBy:${ADA}`)
    expect(row).toHaveTextContent("runKind.plan")
  })

  /**
   * `lint:i18n` only sees literal keys, so every `t(\`x.\${dynamic}\`)` needs a
   * test that walks the runtime authority. Without this, a status added to
   * either union renders its own key as the badge text and nothing fails.
   */
  it("has a catalogue entry for every status and kind it can be handed", () => {
    for (const status of PLAN_STATUSES_FOR_TEST) {
      expect(planLabels(enWorkspace)[status]).toBeTruthy()
      expect(planLabels(zhWorkspace)[status]).toBeTruthy()
    }
    for (const status of RUN_STATUSES_FOR_TEST) {
      expect(runStatusLabels(enWorkspace)[status]).toBeTruthy()
      expect(runStatusLabels(zhWorkspace)[status]).toBeTruthy()
    }
    for (const kind of ["agent-task", "agent-team", "github-loop", "plan"] as const) {
      expect(runKindLabels(enWorkspace)[kind]).toBeTruthy()
      expect(runKindLabels(zhWorkspace)[kind]).toBeTruthy()
    }
  })
})
