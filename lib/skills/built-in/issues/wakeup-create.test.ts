/**
 * @jest-environment jsdom
 */

/**
 * `issue.wakeup_create`: resolves the issue in the session's workspace,
 * writes the rule as the agent through the scheduler policy, and refuses in
 * preflight whatever would fail at write.
 */

jest.mock("@/stores/project/project-store", () => ({
  useProjectStore: { getState: () => ({ activeProjectId: "w1" }) },
}))
jest.mock("@/lib/db/sessions", () => ({ getSession: async () => undefined }))

const mockResolveTaskWrite = jest.fn()
jest.mock("../scheduler/_core", () => ({
  resolveTaskWrite: (...args: unknown[]) => mockResolveTaskWrite(...args),
}))

const mockCreateIssueWakeup = jest.fn()
jest.mock("@/lib/issues/wakeups/service", () => ({
  ...jest.requireActual("@/lib/issues/wakeups/service"),
  createIssueWakeup: (...args: unknown[]) => mockCreateIssueWakeup(...args),
}))

import type { BuiltInSkillContext } from "../types"
import { getSharedBuiltInSkillRegistry } from "../registry"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { createIssueProject } from "@/lib/db/issue-projects"
import { createIssue } from "@/lib/db/issues"
import "./wakeup-create"

const dbFixture = createDbTestFixture()
beforeAll(dbFixture.initialize)
beforeEach(dbFixture.restore)
afterAll(dbFixture.dispose)

const CTX = { sessionId: "s1", humanConfirmed: true } as BuiltInSkillContext
const skill = getSharedBuiltInSkillRegistry().get("issue.wakeup_create")!

let containerId: string
beforeEach(async () => {
  jest.clearAllMocks()
  containerId = (await createIssueProject({ projectId: "w1", name: "Mercury", key: "MERC" })).id
  mockCreateIssueWakeup.mockImplementation(async (input) => ({
    id: "wk1",
    type: "issue-wakeup",
    status: "active",
    trigger: { type: "event", eventType: "issue:activity" },
    payload: { issueId: input.issueId, instruction: input.instruction },
    config: { maxRuns: 20 },
    runCount: 0,
  }))
})

const make = (over: Partial<Parameters<typeof createIssue>[0]> = {}) =>
  createIssue({
    projectId: "w1",
    issueProjectId: containerId,
    title: "x",
    createdBy: { kind: "human" },
    ...over,
  })

it("creates the rule as the agent, attributed to its session", async () => {
  const issue = await make()
  const out = (await skill.execute(
    {
      issue: issue.identifier,
      instruction: "Reply",
      trigger: { on: "event", kinds: ["commented"] },
    } as never,
    CTX
  )) as Record<string, unknown>
  expect(mockCreateIssueWakeup).toHaveBeenCalledWith(
    expect.objectContaining({
      issueId: issue.id,
      instruction: "Reply",
      trigger: { on: "event", kinds: ["commented"] },
      source: "agent",
      createdBy: { kind: "agent", sessionId: "s1" },
      sessionId: "s1",
      humanConfirmed: true,
      author: { kind: "agent" },
    })
  )
  expect(out).toMatchObject({
    status: "created",
    identifier: issue.identifier,
    wakeup: { wakeupId: "wk1" },
  })
})

it("resolves a watched issue by identifier and a one-off time", async () => {
  const issue = await make()
  const watched = await make()
  await skill.execute(
    {
      issue: issue.identifier,
      instruction: "x",
      trigger: { on: "issue-finished", issue: watched.identifier },
    } as never,
    CTX
  )
  expect(mockCreateIssueWakeup.mock.calls[0][0].trigger).toEqual({
    on: "issue-finished",
    targetIssueId: watched.id,
  })
  await skill.execute(
    {
      issue: issue.identifier,
      instruction: "x",
      trigger: { on: "at", runAt: "2030-01-01T00:00:00Z" },
    } as never,
    CTX
  )
  expect(mockCreateIssueWakeup.mock.calls[1][0].trigger).toEqual({
    on: "at",
    runAt: new Date("2030-01-01T00:00:00Z"),
  })
  await expect(
    skill.execute(
      { issue: issue.identifier, instruction: "x", trigger: { on: "at", runAt: "soon" } } as never,
      CTX
    )
  ).rejects.toThrow(/ISO-8601/)
})

it("accepts a pr-checks trigger with or without an outcome", () => {
  const parse = (trigger: unknown) =>
    skill.inputSchema.safeParse({ issue: "MERC-1", instruction: "x", trigger }).success
  expect(parse({ on: "pr-checks" })).toBe(true)
  expect(parse({ on: "pr-checks", result: "failing" })).toBe(true)
  expect(parse({ on: "pr-checks", result: "pending" })).toBe(false)
})

it("passes a deadline and whether to wake when it passes", async () => {
  const issue = await make()
  await skill.execute(
    {
      issue: issue.identifier,
      instruction: "Chase the review",
      trigger: { on: "event", kinds: ["commented"] },
      expiresAt: "2030-01-01T00:00:00Z",
      onTimeout: "wake",
    } as never,
    CTX
  )
  expect(mockCreateIssueWakeup.mock.calls[0][0]).toMatchObject({
    expiresAt: new Date("2030-01-01T00:00:00Z"),
    onTimeout: "wake",
  })
})

it("preflight refuses a finished issue before anyone is asked", async () => {
  const done = await make({ status: "done" })
  await expect(
    skill.preflight!(
      { issue: done.identifier, instruction: "x", trigger: { on: "event" } } as never,
      CTX
    )
  ).rejects.toMatchObject({ reason: "issue-finished" })
  expect(mockResolveTaskWrite).not.toHaveBeenCalled()
})

it("preflight asks the scheduler policy as a create", async () => {
  const issue = await make()
  await skill.preflight!(
    { issue: issue.identifier, instruction: "x", trigger: { on: "event" } } as never,
    CTX
  )
  expect(mockResolveTaskWrite).toHaveBeenCalledWith({
    taskType: "issue-wakeup",
    sessionId: "s1",
    humanConfirmed: true,
    operation: "create",
  })
})

it("validates the trigger shape and kinds", () => {
  const parse = (trigger: unknown) =>
    skill.inputSchema.safeParse({ issue: "MERC-1", instruction: "x", trigger }).success
  expect(parse({ on: "event", kinds: ["child_status_changed"] })).toBe(true)
  expect(parse({ on: "event", kinds: ["wakeup_fired"] })).toBe(false)
  expect(parse({ on: "interval", intervalMs: 1000 })).toBe(false)
  expect(parse({ on: "sometimes" })).toBe(false)
})

it("renders a confirmation card naming the issue and trigger", () => {
  const surface = skill.hitlSurface!({
    issue: "MERC-1",
    instruction: "Reply",
    trigger: { on: "children-done" },
  } as never)
  expect(JSON.stringify(surface)).toContain("MERC-1")
  expect(JSON.stringify(surface)).toContain("children-done")
})
