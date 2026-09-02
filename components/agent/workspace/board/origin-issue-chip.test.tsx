/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, string>) =>
    vars ? `${key}:${Object.values(vars).join(",")}` : key,
}))

import { render, screen } from "@testing-library/react"
import type { AgentTeamTask } from "@/types/agent/agent-team"
import { OriginIssueChips } from "./origin-issue-chip"

const task = (id: string, metadata?: Record<string, unknown>): AgentTeamTask =>
  ({
    id,
    teamId: "team",
    title: id,
    status: "pending",
    tags: [],
    metadata,
  }) as unknown as AgentTeamTask

describe("OriginIssueChips", () => {
  it("renders nothing for a board the team filled on its own", () => {
    const { container } = render(<OriginIssueChips tasks={[task("t1")]} />)
    expect(container).toBeEmptyDOMElement()
  })

  it("links each originating issue back to /issues with it selected", () => {
    render(
      <OriginIssueChips
        tasks={[
          task("t1", { issueId: "iss-1", issueIdentifier: "MERC-2" }),
          task("t2", { issueId: "iss-1", issueIdentifier: "MERC-2" }),
          task("t3", { issueId: "iss 2" }),
        ]}
      />
    )
    const first = screen.getByTestId("origin-issue-chip-iss-1")
    expect(first).toHaveAttribute("href", "/issues?id=iss-1")
    expect(first).toHaveTextContent("label:MERC-2")
    expect(first).toHaveAttribute("aria-label", "open:MERC-2")
    // The bare id stands in for an identifier the adapter did not record.
    const second = screen.getByTestId("origin-issue-chip-iss 2")
    expect(second).toHaveAttribute("href", "/issues?id=iss%202")
    expect(second).toHaveTextContent("label:iss 2")
    expect(screen.getByTestId("board-origin-issues").children).toHaveLength(2)
  })
})
