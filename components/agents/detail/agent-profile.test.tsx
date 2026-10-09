/** @jest-environment jsdom */

// One agent's profile (ADR-0220): the activity feed, open work drawn the way
// the issue tracker draws it, the links out to the task board and to Issues,
// and the side column's facts and stats.

import { fireEvent, render, screen, within } from "@testing-library/react"

import type { Character, ChatSession } from "@cognia/agent-config-types"
import type { AgentCatalogs } from "@/hooks/agents/use-agent-catalogs"
import type { AgentActivity } from "@/lib/agents/agent-activity"
import type { AgentTask } from "@/types/agent/agent-task"
import type { Issue } from "@/types/issues"

jest.mock("@/hooks/agent/use-agent-runtime-catalog", () => ({
  useAgentRuntimeCatalog: () => ({ runtimes: [] }),
}))

let capabilitiesProps: { onEdit?: () => void } | undefined
jest.mock("./agent-capabilities-section", () => ({
  AgentCapabilitiesSection: (props: { onEdit?: () => void }) => {
    capabilitiesProps = props
    return <div data-testid="capabilities-stub" />
  },
}))

import { AgentProfile, FEED_PREVIEW } from "./agent-profile"

const NOW = Date.now()

function agent(over: Partial<Character> = {}): Character {
  return {
    id: "char_1",
    name: "Alpha",
    avatarColor: "#123456",
    systemPrompt: "",
    createdAt: 1,
    updatedAt: NOW,
    ...over,
  } as Character
}

function task(id: string, over: Partial<AgentTask> = {}): AgentTask {
  return {
    id,
    agentId: "char_1",
    title: `Task ${id}`,
    description: "",
    status: "pending",
    priority: "normal",
    dependencies: [],
    tags: [],
    order: 0,
    approvalPolicy: "on-risk",
    latestAttemptNo: 0,
    comments: [],
    createdAt: 0,
    updatedAt: NOW,
    revision: 1,
    ...over,
  }
}

function issue(id: string, over: Partial<Issue> = {}): Issue {
  return {
    id,
    identifier: `MERC-${id}`,
    title: `Issue ${id}`,
    status: "todo",
    statusCategory: "unstarted",
    priority: "high",
    updatedAt: NOW,
    ...over,
  } as unknown as Issue
}

function session(id: string, over: Partial<ChatSession> = {}): ChatSession {
  return {
    id,
    title: `Chat ${id}`,
    createdAt: 0,
    updatedAt: NOW,
    ...over,
  } as unknown as ChatSession
}

function activity(over: Partial<AgentActivity> = {}): AgentActivity {
  return {
    status: "idle",
    now: [],
    recent: [],
    openTasks: [],
    openIssues: [],
    stats: {
      conversations: 0,
      turns: 0,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      completedTasks: 0,
      completedIssues: 0,
    },
    ...over,
  }
}

const catalogs = { skills: [], mcpServers: [], knowledgeBases: [] } as unknown as AgentCatalogs

function renderProfile(props: Partial<React.ComponentProps<typeof AgentProfile>> = {}): {
  onOpenTasks: jest.Mock
} {
  const onOpenTasks = jest.fn()
  render(
    <AgentProfile
      agent={agent()}
      activity={activity()}
      catalogs={catalogs}
      sourceLabel="Created by you"
      onOpenTasks={onOpenTasks}
      {...props}
    />
  )
  return { onOpenTasks }
}

beforeEach(() => {
  capabilitiesProps = undefined
})

describe("AgentProfile — empty", () => {
  it("says so in one line per section instead of leaving blank space", () => {
    renderProfile({ activity: undefined })
    expect(screen.getByTestId("agent-section-activity")).toHaveTextContent(
      "Nothing yet. Chat with it or assign it work"
    )
    expect(screen.getByTestId("agent-section-work")).toHaveTextContent("No open work.")
    expect(screen.queryByTestId("agent-work-list")).not.toBeInTheDocument()
  })
})

describe("AgentProfile — open work", () => {
  it("merges unfinished tasks and open issues, most recently touched first", () => {
    renderProfile({
      activity: activity({
        openTasks: [task("t1", { updatedAt: NOW - 3000 }), task("t2", { updatedAt: NOW - 1000 })],
        openIssues: [issue("i1", { updatedAt: NOW - 2000 })],
      }),
    })
    const rows = within(screen.getByTestId("agent-work-list")).getAllByRole("listitem")
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining("Task t2"),
      expect.stringContaining("Issue i1"),
      expect.stringContaining("Task t1"),
    ])
    expect(screen.getByTestId("agent-section-work")).toHaveTextContent("3 open")
  })

  it("draws a task with the tracker's glyphs, keeps its own status word, and opens the board", () => {
    const { onOpenTasks } = renderProfile({
      activity: activity({ openTasks: [task("t1", { status: "paused", priority: "critical" })] }),
    })
    const row = screen.getByTestId("agent-work-task")
    expect(row).toHaveAttribute("data-task-status", "paused")
    // paused maps onto the tracker's in-progress glyph, critical onto urgent.
    expect(within(row).getByTestId("issue-status-icon-in_progress")).toBeInTheDocument()
    expect(within(row).getByTestId("issue-priority-icon-urgent")).toBeInTheDocument()
    expect(row).toHaveTextContent("Paused")
    fireEvent.click(row)
    expect(onOpenTasks).toHaveBeenCalledTimes(1)
  })

  it("links an issue to the tracker with it selected", () => {
    renderProfile({
      activity: activity({ openIssues: [issue("iss_9", { status: "in_review" })] }),
    })
    const row = screen.getByTestId("agent-work-issue")
    expect(row).toHaveAttribute("href", "/issues?id=iss_9")
    expect(row).toHaveTextContent("MERC-iss_9")
    expect(within(row).getByTestId("issue-status-icon-in_review")).toBeInTheDocument()
    expect(within(row).getByTestId("issue-priority-icon-high")).toBeInTheDocument()
  })

  it("previews a long list and expands it on request", () => {
    const tasks = Array.from({ length: FEED_PREVIEW + 2 }, (_, i) =>
      task(`t${i}`, { updatedAt: NOW - i })
    )
    renderProfile({ activity: activity({ openTasks: tasks }) })
    expect(screen.getAllByTestId("agent-work-task")).toHaveLength(FEED_PREVIEW)
    fireEvent.click(screen.getByTestId("agent-work-toggle"))
    expect(screen.getAllByTestId("agent-work-task")).toHaveLength(FEED_PREVIEW + 2)
    fireEvent.click(screen.getByTestId("agent-work-toggle"))
    expect(screen.getAllByTestId("agent-work-task")).toHaveLength(FEED_PREVIEW)
  })

  it("opens the full-width board from the section header", () => {
    const { onOpenTasks } = renderProfile()
    fireEvent.click(screen.getByTestId("agent-work-board"))
    expect(onOpenTasks).toHaveBeenCalledTimes(1)
  })

  it("points at the tracker filtered to this agent, except on a phone", () => {
    renderProfile()
    expect(screen.getByTestId("agent-work-issues")).toHaveAttribute(
      "href",
      "/issues?assignee=agent%3Achar_1"
    )
  })

  it("leaves the Issues link out on a phone, whose issue list cannot filter", () => {
    renderProfile({ compact: true })
    expect(screen.queryByTestId("agent-work-issues")).not.toBeInTheDocument()
    expect(screen.getByTestId("agent-work-board")).toBeInTheDocument()
  })
})

describe("AgentProfile — activity feed", () => {
  it("puts live work first and links each row where it can be watched", () => {
    const { onOpenTasks } = renderProfile({
      activity: activity({
        now: [
          { kind: "session", session: session("s1"), status: "awaiting_approval" },
          { kind: "task", task: task("t-live", { status: "in_progress" }) },
        ],
        recent: [
          {
            kind: "session",
            session: session("s2", { archivedAt: NOW } as Partial<ChatSession>),
            at: NOW,
          },
          { kind: "issue", issue: issue("i-done"), at: NOW },
          { kind: "task", task: task("t-done", { status: "completed" }), at: NOW },
        ],
      }),
    })
    const live = screen.getAllByTestId("agent-feed-live")
    expect(live[0]).toHaveAttribute("href", "/?session=s1")
    expect(live[0]).toHaveTextContent("Needs approval")
    expect(live[1]).toHaveTextContent("Task t-live")
    fireEvent.click(live[1])
    expect(onOpenTasks).toHaveBeenCalledTimes(1)

    const recent = screen.getAllByTestId("agent-feed-row")
    expect(recent[0]).toHaveAttribute("href", "/?session=s2")
    expect(recent[0]).toHaveTextContent("Archived")
    expect(recent[1]).toHaveAttribute("href", "/issues?id=i-done")
    fireEvent.click(recent[2])
    expect(onOpenTasks).toHaveBeenCalledTimes(2)
    expect(screen.getByTestId("agent-section-activity")).toHaveTextContent("2 live")
  })

  it("names an untitled conversation instead of leaving the row blank", () => {
    renderProfile({
      activity: activity({
        recent: [{ kind: "session", session: session("s3", { title: "" }), at: NOW }],
      }),
    })
    expect(screen.getByTestId("agent-feed-row")).toHaveTextContent("Untitled conversation")
  })

  it("previews the feed and expands it on request", () => {
    const recent = Array.from({ length: FEED_PREVIEW + 1 }, (_, i) => ({
      kind: "session" as const,
      session: session(`s${i}`),
      at: NOW - i,
    }))
    renderProfile({ activity: activity({ recent }) })
    expect(screen.getAllByTestId("agent-feed-row")).toHaveLength(FEED_PREVIEW)
    fireEvent.click(screen.getByTestId("agent-activity-toggle"))
    expect(screen.getAllByTestId("agent-feed-row")).toHaveLength(FEED_PREVIEW + 1)
  })
})

describe("AgentProfile — side column", () => {
  it("lists where it came from, its models and its working directory", () => {
    renderProfile({
      agent: agent({
        modelRouting: { execute: "exec-model", plan: "plan-model", utility: "util-model" },
        workingDir: "/repo",
      }),
    })
    const facts = screen.getByTestId("agent-facts")
    expect(facts).toHaveTextContent("Created by you")
    expect(facts).toHaveTextContent("exec-model")
    expect(facts).toHaveTextContent("plan-model")
    expect(facts).toHaveTextContent("util-model")
    expect(facts).toHaveTextContent("/repo")
    expect(facts).toHaveTextContent("Follows the app")
  })

  it("falls back to the default model and hides rows it has nothing for", () => {
    renderProfile()
    const facts = screen.getByTestId("agent-facts")
    expect(facts).toHaveTextContent("Default")
    expect(facts).not.toHaveTextContent("Plan model")
    expect(facts).not.toHaveTextContent("Working dir")
  })

  it("sums the last 30 days", () => {
    renderProfile({
      activity: activity({
        stats: {
          conversations: 4,
          turns: 9,
          inputTokens: 1000,
          outputTokens: 500,
          costUsd: 1.25,
          completedTasks: 2,
          completedIssues: 1,
        },
      }),
    })
    const stats = screen.getByTestId("agent-stats")
    expect(stats).toHaveTextContent("4")
    expect(stats).toHaveTextContent("9")
    // completed = tasks + issues
    expect(within(stats).getByText("Completed").nextElementSibling).toHaveTextContent("3")
    expect(within(stats).getByText("Cost").nextElementSibling).toHaveTextContent("$1.25")
  })

  it("passes Edit through to the capabilities only when given", () => {
    const onEdit = jest.fn()
    renderProfile({ onEdit })
    expect(capabilitiesProps?.onEdit).toBe(onEdit)
  })
})
