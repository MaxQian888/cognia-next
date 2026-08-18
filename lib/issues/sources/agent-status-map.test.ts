import type { AgentTaskStatus } from "@/types/agent/agent-task"
import type { TeamTaskStatus } from "@/types/agent/agent-team"
import { statusCategoryOf } from "@/types/issues"
import {
  agentTaskPriorityToIssuePriority,
  agentTaskStatusToIssueStatus,
  subAgentPriorityToIssuePriority,
  teamTaskStatusToIssueStatus,
} from "./agent-status-map"

describe("agentTaskStatusToIssueStatus", () => {
  it.each<[AgentTaskStatus, string]>([
    ["pending", "backlog"],
    ["blocked", "todo"],
    ["in_progress", "in_progress"],
    ["paused", "in_progress"],
    ["review", "in_review"],
    ["completed", "done"],
    ["failed", "canceled"],
    ["cancelled", "canceled"],
  ])("%s → %s", (from, to) => {
    expect(agentTaskStatusToIssueStatus(from)).toBe(to)
  })

  it("keeps failed out of the completed category so progress bars stay honest", () => {
    expect(statusCategoryOf(agentTaskStatusToIssueStatus("failed"))).toBe("canceled")
    expect(statusCategoryOf(agentTaskStatusToIssueStatus("completed"))).toBe("completed")
  })
})

describe("teamTaskStatusToIssueStatus", () => {
  it.each<[TeamTaskStatus, string]>([
    ["pending", "backlog"],
    ["blocked", "todo"],
    ["claimed", "todo"],
    ["in_progress", "in_progress"],
    ["review", "in_review"],
    ["completed", "done"],
    ["failed", "canceled"],
    ["cancelled", "canceled"],
  ])("%s → %s", (from, to) => {
    expect(teamTaskStatusToIssueStatus(from)).toBe(to)
  })
})

describe("priority projections", () => {
  it("maps both engine scales onto IssuePriority", () => {
    expect(agentTaskPriorityToIssuePriority("critical")).toBe("urgent")
    expect(agentTaskPriorityToIssuePriority("high")).toBe("high")
    expect(agentTaskPriorityToIssuePriority("normal")).toBe("medium")
    expect(agentTaskPriorityToIssuePriority("low")).toBe("low")
    expect(subAgentPriorityToIssuePriority("critical")).toBe("urgent")
    expect(subAgentPriorityToIssuePriority("high")).toBe("high")
    expect(subAgentPriorityToIssuePriority("normal")).toBe("medium")
    expect(subAgentPriorityToIssuePriority("low")).toBe("low")
    expect(subAgentPriorityToIssuePriority("background")).toBe("none")
  })
})
