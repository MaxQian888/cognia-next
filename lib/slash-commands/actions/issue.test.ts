const mockResolve = jest.fn(async (_ref: string): Promise<unknown> => undefined)
const mockCreate = jest.fn(async (req: unknown) => ({
  id: "new",
  identifier: "MERC-9",
  title: "t",
  ...(req as object),
}))
const mockQuery = jest.fn(async (_q: unknown): Promise<unknown[]> => [])
const mockApply = jest.fn(async (..._a: unknown[]) => ({ applied: 1, skipped: 0, failed: 0 }))
jest.mock("@/lib/issues/service", () => {
  const actual = jest.requireActual("@/lib/issues/service")
  return {
    ...actual,
    resolveIssue: (ref: string) => mockResolve(ref),
    createIssueRecord: (req: unknown) => mockCreate(req),
    queryIssues: (q: unknown) => mockQuery(q),
    applyIssueAction: (...a: unknown[]) => mockApply(...a),
  }
})

const mockStartNewSession = jest.fn(async (seed: unknown) => ({
  id: "ses_new",
  ...(seed as object),
}))
jest.mock("@/lib/chat/start-session", () => ({
  startNewSession: (seed: unknown) => mockStartNewSession(seed),
}))
const mockSetActiveSession = jest.fn()
jest.mock("@/stores/chat", () => ({
  useChatStore: { getState: () => ({ setActiveSession: mockSetActiveSession }) },
}))
const mockStage = jest.fn()
jest.mock("@/stores/chat/composer-intent-store", () => ({
  useComposerIntentStore: { getState: () => ({ stage: mockStage }) },
}))
const mockCreatePlan = jest.fn(async (input: unknown) => ({ id: "p1", ...(input as object) }))
jest.mock("@/lib/agent/plan/runtime", () => ({
  getPlanRuntime: () => ({ createPlan: (input: unknown) => mockCreatePlan(input) }),
}))

import { dispatchIssueSubcommand, issuePrompt, parseNewArgs } from "./issue"
import type { SlashContext } from "../builtin"

function ctx(args: string): SlashContext {
  return {
    args,
    activeSessionId: "ses_a",
    chatStatus: "ready",
    currentPermissionMode: null,
    startNewSession: () => {},
    openSettings: () => {},
    setPermissionMode: () => {},
    pushSystemMessage: () => {},
  }
}

const issue = {
  id: "i1",
  identifier: "MERC-1",
  title: "Login broken",
  status: "todo",
  priority: "high",
  assignee: { kind: "human", label: "Me" },
  externalRefs: [],
}

beforeEach(() => {
  jest.clearAllMocks()
  mockResolve.mockResolvedValue(issue)
})

describe("/issue list", () => {
  it("lists open issues by default, with links, and caps the list", async () => {
    mockQuery.mockResolvedValueOnce(
      Array.from({ length: 17 }, (_, i) => ({ ...issue, id: `i${i}`, identifier: `MERC-${i}` }))
    )
    const { system } = await dispatchIssueSubcommand(ctx(""))
    expect(mockQuery).toHaveBeenCalledWith({
      statuses: ["backlog", "todo", "in_progress", "in_review"],
    })
    expect(system).toContain("[MERC-0](/issues?id=i0) Login broken")
    expect(system).toContain("and 2 more")
  })

  it("takes a status and a text needle", async () => {
    await dispatchIssueSubcommand(ctx("list done login page"))
    expect(mockQuery).toHaveBeenCalledWith({ statuses: ["done"], text: "login page" })
    expect((await dispatchIssueSubcommand(ctx("list done"))).system).toContain("No issues match")
  })
})

describe("/issue new", () => {
  it("parses #KEY, !priority, @me and a | description out of the title", () => {
    expect(parseNewArgs("Fix login #merc !high @me | It 500s on submit")).toEqual({
      title: "Fix login",
      description: "It 500s on submit",
      projectKey: "MERC",
      priority: "high",
      assignSelf: true,
    })
    expect(parseNewArgs("#notakey-way-too-long Title")).toMatchObject({
      title: "#notakey-way-too-long Title",
    })
  })

  it("creates with the session as origin and links the result", async () => {
    const { system } = await dispatchIssueSubcommand(ctx("new Fix login #merc @me"))
    expect(mockCreate).toHaveBeenCalledWith({
      title: "Fix login",
      by: { kind: "human" },
      projectKey: "MERC",
      assignee: { kind: "human" },
      origin: { kind: "chat", sessionId: "ses_a" },
    })
    expect(system).toContain("[MERC-9](/issues?id=new)")
  })

  it("prints usage for an empty title and surfaces a service error", async () => {
    expect((await dispatchIssueSubcommand(ctx("new #merc"))).system).toContain("Usage")
    mockCreate.mockRejectedValueOnce(new Error("Create a project first"))
    expect((await dispatchIssueSubcommand(ctx("new x"))).system).toContain(
      "⚠️ Create a project first"
    )
  })
})

describe("/issue show / status / priority / assign / comment", () => {
  it("renders a card", async () => {
    const { system } = await dispatchIssueSubcommand(ctx("show merc-1"))
    expect(mockResolve).toHaveBeenCalledWith("merc-1")
    expect(system).toContain("**[MERC-1](/issues?id=i1) Login broken**")
    expect(system).toContain("Assignee: Me")
  })

  it("moves through the board gate and reports a refusal", async () => {
    expect((await dispatchIssueSubcommand(ctx("status MERC-1 done"))).system).toBe(
      "✅ MERC-1: moved to done."
    )
    expect(mockApply).toHaveBeenCalledWith(issue, { kind: "status", to: "done" }, { kind: "human" })
    mockApply.mockResolvedValueOnce({ applied: 0, skipped: 1, failed: 0, reason: "running" })
    expect((await dispatchIssueSubcommand(ctx("status MERC-1 done"))).system).toContain(
      "refused (running)"
    )
    expect((await dispatchIssueSubcommand(ctx("status MERC-1 closed"))).system).toContain(
      "Unknown status"
    )
  })

  it("reprioritises, assigns to me/none/team, and comments", async () => {
    await dispatchIssueSubcommand(ctx("priority MERC-1 low"))
    expect(mockApply).toHaveBeenLastCalledWith(
      issue,
      { kind: "priority", to: "low" },
      expect.anything()
    )
    await dispatchIssueSubcommand(ctx("assign MERC-1 none"))
    expect(mockApply).toHaveBeenLastCalledWith(
      issue,
      { kind: "assignee", to: null },
      expect.anything()
    )
    await dispatchIssueSubcommand(ctx("assign MERC-1 team:t1"))
    expect(mockApply).toHaveBeenLastCalledWith(
      issue,
      { kind: "assignee", to: { kind: "team", id: "t1" } },
      expect.anything()
    )
    expect((await dispatchIssueSubcommand(ctx("assign MERC-1 bob"))).system).toContain("must be")
    await dispatchIssueSubcommand(ctx("comment MERC-1 looks fixed now"))
    expect(mockApply).toHaveBeenLastCalledWith(
      issue,
      { kind: "comment", body: "looks fixed now" },
      expect.anything()
    )
  })

  it("says so for an unknown ref or subcommand", async () => {
    mockResolve.mockResolvedValueOnce(undefined)
    expect((await dispatchIssueSubcommand(ctx("show MERC-404"))).system).toContain(
      "No issue matches"
    )
    expect((await dispatchIssueSubcommand(ctx("bogus"))).system).toContain("Unknown subcommand")
  })
})

describe("/issue chat and /issue plan", () => {
  it("opens a session bound to the issue and stages the issue as the first prompt", async () => {
    const { system } = await dispatchIssueSubcommand(ctx("chat MERC-1"))
    expect(mockStartNewSession).toHaveBeenCalledWith({
      title: "MERC-1 Login broken",
      projectId: undefined,
      issueId: "i1",
    })
    expect(mockSetActiveSession).toHaveBeenCalledWith("ses_new")
    expect(mockStage).toHaveBeenCalledWith("ses_new", {
      candidateId: "issue-chat:i1",
      prompt: "Work on MERC-1: Login broken",
    })
    expect(system).toContain("[MERC-1](/issues?id=i1)")
    expect(issuePrompt({ ...issue, description: " why " } as never)).toBe(
      "Work on MERC-1: Login broken\n\nwhy"
    )
  })

  it("drafts a one-step manual plan bound to the issue in the active session", async () => {
    const { system } = await dispatchIssueSubcommand(ctx("plan MERC-1"))
    expect(mockCreatePlan).toHaveBeenCalledWith({
      sessionId: "ses_a",
      title: "MERC-1: Login broken",
      source: "manual",
      steps: [{ title: "Resolve MERC-1", kind: "agent_turn", issueId: "i1" }],
    })
    expect(system).toContain("Drafted plan")
    const noSession = { ...ctx("plan MERC-1"), activeSessionId: null }
    expect((await dispatchIssueSubcommand(noSession)).system).toContain("Start a chat session")
  })
})
