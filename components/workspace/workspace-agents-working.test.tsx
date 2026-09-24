import { render, screen, within } from "@testing-library/react"

import en from "@/i18n/messages/en/issues.json"
import zhCN from "@/i18n/messages/zh-CN/issues.json"
import type { ActiveAgentRun } from "@/lib/workspace/active-agent-runs"
import { AGENTS_WORKING_REGION_ID, WorkspaceAgentsWorking } from "./workspace-agents-working"

jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}))

const NOW = new Date("2026-09-24T12:00:00Z")

function entry(over: Partial<ActiveAgentRun>): ActiveAgentRun {
  return {
    runId: "r1",
    issueId: "iss_1",
    issueIdentifier: "MERC-1",
    issueTitle: "Write the docs",
    adapterId: "agent-task",
    kind: "agent-task",
    status: "running",
    startedAt: NOW.getTime() - 5 * 60_000,
    href: "/?session=s-1",
    linkKind: "session",
    issueHref: "/issues?id=iss_1",
    ...over,
  }
}

// jest.setup's global next-intl mock resolves keys against the English bundle
// and renders relative times as ISO strings.
function renderList(runs: ActiveAgentRun[]) {
  return render(<WorkspaceAgentsWorking runs={runs} />)
}

describe("WorkspaceAgentsWorking", () => {
  it("renders as the region the tile controls", () => {
    renderList([])
    expect(document.getElementById(AGENTS_WORKING_REGION_ID)).not.toBeNull()
  })

  it("says so when no agent is working", () => {
    renderList([])
    expect(screen.getByTestId("workspace-agents-working-empty")).toHaveTextContent(
      "No agent is working in this workspace right now."
    )
  })

  it("lists each run with its issue, engine, start time, status, and a link to watch it", () => {
    renderList([
      entry({}),
      entry({
        runId: "r2",
        issueId: "iss_2",
        issueIdentifier: "MERC-2",
        issueTitle: "Fix the build",
        adapterId: "agent-team",
        kind: "agent-team",
        status: "queued",
        href: "/squads?id=team-1",
        linkKind: "squad",
        issueHref: "/issues?id=iss_2",
      }),
    ])

    const first = screen.getByTestId("workspace-agent-run-r1")
    expect(within(first).getByTestId("workspace-agent-run-issue-r1")).toHaveAttribute(
      "href",
      "/issues?id=iss_1"
    )
    expect(first).toHaveTextContent("MERC-1")
    expect(first).toHaveTextContent("Write the docs")
    expect(first).toHaveTextContent(
      `Agent task · started ${new Date(NOW.getTime() - 5 * 60_000).toISOString()}`
    )
    expect(first).toHaveTextContent("Running")
    const openSession = within(first).getByRole("link", { name: "Open session" })
    expect(openSession).toHaveAttribute("href", "/?session=s-1")

    const second = screen.getByTestId("workspace-agent-run-r2")
    expect(second).toHaveTextContent("Queued")
    expect(within(second).getByRole("link", { name: "Open squad" })).toHaveAttribute(
      "href",
      "/squads?id=team-1"
    )
  })

  it.each([
    ["agent-board", "Open task board"],
    ["issue", "Open issue"],
  ] as const)("labels a %s link", (linkKind, label) => {
    renderList([entry({ linkKind, href: "/x" })])
    expect(screen.getByRole("link", { name: label })).toHaveAttribute("href", "/x")
  })

  it("does not invent a title for a run whose issue row is gone", () => {
    renderList([entry({ issueTitle: undefined, issueIdentifier: undefined })])
    expect(screen.getByTestId("workspace-agent-run-issue-r1")).toHaveTextContent(
      "Issue no longer available"
    )
  })

  it("falls back to the adapter id for an engine without a translated name", () => {
    renderList([entry({ adapterId: "future-engine" })])
    expect(screen.getByTestId("workspace-agent-run-r1")).toHaveTextContent(
      "future-engine · started"
    )
  })

  it("has every string it renders in both locales", () => {
    const keys = [
      "agentsWorkingShow",
      "agentsWorkingHide",
      "agentsWorkingEmpty",
      "agentsWorkingMissingIssue",
      "agentsWorkingMeta",
    ] as const
    for (const key of keys) {
      expect(en.workspace[key]).toEqual(expect.any(String))
      expect(zhCN.workspace[key]).toEqual(expect.any(String))
    }
    expect(Object.keys(zhCN.workspace.agentsWorkingOpen).sort()).toEqual(
      Object.keys(en.workspace.agentsWorkingOpen).sort()
    )
    expect(zhCN.workspace.agentsWorkingMeta).toContain("{engine}")
    expect(zhCN.workspace.agentsWorkingMeta).toContain("{time}")
  })
})
