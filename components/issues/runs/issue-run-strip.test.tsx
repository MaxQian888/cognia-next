/**
 * @jest-environment jsdom
 */

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
}))

import { render, screen } from "@testing-library/react"
import type { IssueRun, IssueRunStatus } from "@/types/issues"
import { IssueRunStrip } from "./issue-run-strip"

const run = (id: string, status: IssueRunStatus, startedAt: number): IssueRun => ({
  id,
  issueId: "i1",
  projectId: "w1",
  adapterId: "agent-task",
  kind: "agent-task",
  targetId: "t",
  status,
  by: { kind: "human" },
  startedAt,
  updatedAt: startedAt,
  artifacts: [],
})

it("draws one mark per run, oldest first, and stays out of the way for a single run", () => {
  const { rerender, container } = render(<IssueRunStrip runs={[run("a", "failed", 1)]} />)
  expect(container).toBeEmptyDOMElement()
  rerender(
    <IssueRunStrip
      runs={[run("c", "running", 3), run("b", "succeeded", 2), run("a", "failed", 1)]}
    />
  )
  const marks = screen.getByTestId("issue-run-strip").querySelectorAll("li")
  expect([...marks].map((mark) => mark.getAttribute("data-testid"))).toEqual([
    "issue-run-strip-failed",
    "issue-run-strip-succeeded",
    "issue-run-strip-running",
  ])
  expect(marks[0]!.getAttribute("title")).toContain("run.timelineEntry")
})
