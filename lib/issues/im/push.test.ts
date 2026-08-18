/**
 * @jest-environment jsdom
 */

import type { Issue } from "@/types/issues"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { createIssueProject } from "@/lib/db/issue-projects"
import { createIssue } from "@/lib/db/issues"
import { createIssueRun } from "@/lib/db/issue-runs"
import {
  IssueRunRegistry,
  resetIssueRunRegistry,
  getIssueRunRegistry,
} from "@/lib/issues/run/registry"
import { issueOpenHref, pushIssueCard, pushIssueText, type IssueImPushDeps } from "./push"

const dbFixture = createDbTestFixture()
beforeAll(dbFixture.initialize)
beforeEach(dbFixture.restore)
afterAll(dbFixture.dispose)
afterEach(resetIssueRunRegistry)

function makeDeps(over: Partial<IssueImPushDeps> = {}) {
  const sent: unknown[] = []
  const audits: unknown[] = []
  const deps: IssueImPushDeps = {
    enqueue: async (input) => {
      sent.push(input)
    },
    buildSegment: (surfaceId, content) => ({ type: "a2ui", surfaceId, content }),
    audit: async (entry) => {
      audits.push(entry)
    },
    isPiiSafe: () => true,
    now: () => 7,
    ...over,
  }
  return { deps, sent, audits }
}

async function seedIssue(status: Issue["status"] = "todo") {
  const project = await createIssueProject({ projectId: "w1", name: "M", key: "MERC" })
  return createIssue({
    projectId: "w1",
    issueProjectId: project.id,
    title: "t",
    createdBy: { kind: "human" },
    status,
    assignee: { kind: "agent", id: "c1", label: "Ada" },
  })
}

describe("issueOpenHref", () => {
  it("prefixes the configured origin and tolerates a trailing slash", () => {
    expect(issueOpenHref("i1", "https://app.example/")).toBe("https://app.example/issues?id=i1")
    expect(issueOpenHref("i1", "")).toBe("/issues?id=i1")
  })
})

describe("pushIssueText", () => {
  it("enqueues a text segment through the governed gateway", async () => {
    const { deps, sent } = makeDeps()
    const status = await pushIssueText(
      { adapterId: "lark-1", conversationKey: "lark:lark-1:oc_1", text: "hi", idempotencyKey: "k" },
      deps
    )
    expect(status).toBe("sent")
    expect(sent[0]).toMatchObject({
      adapterId: "lark-1",
      conversationKey: "lark:lark-1:oc_1",
      source: "skill",
      request: {
        conversationRef: { platform: "lark", adapterId: "lark-1" },
        segments: [{ type: "text", text: "hi" }],
        metadata: { idempotencyKey: "k" },
      },
    })
  })

  it("blocks and audits text that fails the PII gate", async () => {
    const { deps, sent, audits } = makeDeps({ isPiiSafe: () => false })
    const status = await pushIssueText(
      { adapterId: "lark-1", conversationKey: "lark:lark-1:oc_1", text: "x", idempotencyKey: "k" },
      deps
    )
    expect(status).toBe("pii_blocked")
    expect(sent).toEqual([])
    expect(audits[0]).toMatchObject({ kind: "issue.im_pii_blocked", reason: "pii_blocked" })
  })
})

describe("pushIssueCard", () => {
  it("derives move targets from the state machine and Run from the registry", async () => {
    const issue = await seedIssue("todo")
    getIssueRunRegistry().register({
      id: "fake",
      kind: "agent-task",
      canRun: async () => ({ ok: true }),
      start: async () => {
        throw new Error("unused")
      },
      poll: async () => null,
    })
    const { deps, sent } = makeDeps()
    const result = await pushIssueCard(
      { adapterId: "lark-1", conversationKey: "lark:lark-1:oc_1", issue, idempotencyKey: "ik" },
      deps
    )
    expect(result.status).toBe("sent")
    expect(result.surfaceId).toMatch(/^issue:/)
    const segment = (
      sent[0] as {
        request: {
          segments: Array<{ content: { components: Record<string, { children?: string[] }> } }>
        }
      }
    ).request.segments[0]
    const actions = segment.content.components.actions.children!
    // in_progress is the runtime's column and never a card target.
    expect(actions).toEqual(["move_backlog", "move_in_review", "move_done", "move_canceled", "run"])
  })

  it("hides Run and every move while a run is active", async () => {
    const issue = await seedIssue("in_progress")
    await createIssueRun({
      issueId: issue.id,
      projectId: "w1",
      adapterId: "fake",
      kind: "agent-task",
      targetId: "t",
      by: { kind: "human" },
    })
    const { deps, sent } = makeDeps()
    await pushIssueCard({ adapterId: "lark-1", conversationKey: "lark:lark-1:oc_1", issue }, deps)
    const segment = (
      sent[0] as {
        request: { segments: Array<{ content: { components: Record<string, unknown> } }> }
      }
    ).request.segments[0]
    expect(segment.content.components.actions).toBeUndefined()
    expect(segment.content.components.runtimeOwned).toBeDefined()
  })

  it("honours injected runActive/canRun and blocks PII", async () => {
    const issue = await seedIssue()
    const registry = new IssueRunRegistry()
    void registry
    const { deps, sent, audits } = makeDeps({ isPiiSafe: () => false })
    const result = await pushIssueCard(
      {
        adapterId: "lark-1",
        conversationKey: "lark:lark-1:oc_1",
        issue,
        runActive: false,
        canRun: false,
      },
      deps
    )
    expect(result.status).toBe("pii_blocked")
    expect(sent).toEqual([])
    expect(audits[0]).toMatchObject({ kind: "issue.im_pii_blocked", fields: { issueId: issue.id } })
  })
})
