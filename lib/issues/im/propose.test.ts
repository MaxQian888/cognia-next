/**
 * @jest-environment jsdom
 */

import type { IssueProject } from "@/types/issues"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { patchConversationOverride } from "@/lib/db/conversation-overrides"
import { createIssueProject } from "@/lib/db/issue-projects"
import {
  MAX_PROJECT_BUTTONS,
  proposeIssueFromIm,
  resolveCandidateProjects,
  type ProposeIssueDeps,
} from "./propose"

const dbFixture = createDbTestFixture()
beforeAll(dbFixture.initialize)
beforeEach(dbFixture.restore)
afterAll(dbFixture.dispose)

const CONV = "lark:lark-1:oc_1"

function project(id: string, updatedAt: number): IssueProject {
  return {
    id,
    projectId: "w1",
    key: id.toUpperCase(),
    name: `P ${id}`,
    status: "planned",
    priority: "none",
    resources: [],
    createdAt: 1,
    updatedAt,
  }
}

describe("resolveCandidateProjects", () => {
  it("puts the remembered project first, then recency, capped", async () => {
    const all = ["a", "b", "c", "d", "e", "f", "g"].map((id, i) => project(id, i))
    const out = await resolveCandidateProjects("w1", CONV, {
      listProjects: async () => all,
      remembered: async () => "b",
    })
    expect(out.defaultProjectId).toBe("b")
    expect(out.projects.map((p) => p.id)).toEqual(["b", "g", "f", "e", "d"])
    expect(out.projects).toHaveLength(MAX_PROJECT_BUTTONS)
    const none = await resolveCandidateProjects("w1", CONV, {
      listProjects: async () => all.slice(0, 2),
      remembered: async () => "zzz",
    })
    expect(none.defaultProjectId).toBeUndefined()
    expect(none.projects.map((p) => p.id)).toEqual(["b", "a"])
  })
})

describe("proposeIssueFromIm", () => {
  function harness(over: Partial<ProposeIssueDeps> = {}) {
    const sent: unknown[] = []
    const audits: unknown[] = []
    const deps: Partial<ProposeIssueDeps> = {
      push: {
        enqueue: async (input) => {
          sent.push(input)
        },
        buildSegment: (surfaceId, content) => ({ type: "a2ui", surfaceId, content }),
        audit: async (entry) => {
          audits.push(entry)
        },
        isPiiSafe: () => true,
        now: () => 1,
      },
      newId: () => "draft1",
      ...over,
    }
    return { deps, sent, audits }
  }

  it("pushes the confirmation card and writes nothing", async () => {
    const p1 = await createIssueProject({ projectId: "w1", name: "Mercury", key: "MERC" })
    await createIssueProject({ projectId: "w1", name: "Venus", key: "VEN" })
    await patchConversationOverride(CONV, { issueProjectId: p1.id }, "sess")
    const { deps, sent } = harness()
    const out = await proposeIssueFromIm(
      {
        adapterId: "lark-1",
        conversationKey: CONV,
        workspaceId: "w1",
        title: "  Fix login  ",
        description: " 500 ",
        sourceMessageId: "m1",
      },
      deps
    )
    expect(out).toMatchObject({
      status: "proposed",
      surfaceId: "issue-create:draft1",
      draftId: "draft1",
    })
    expect((out as { projectIds: string[] }).projectIds[0]).toBe(p1.id)
    const req = (
      sent[0] as {
        request: {
          segments: Array<{ content: { components: Record<string, Record<string, unknown>> } }>
          metadata: { idempotencyKey: string }
        }
        source: string
      }
    ).request
    expect(req.metadata.idempotencyKey).toBe("issue-propose:draft1")
    const button = req.segments[0].content.components[`project_${p1.id}`]
    expect(button).toMatchObject({
      variant: "primary",
      bindingPayload: {
        action: "create",
        issueProjectId: p1.id,
        draft: { draftId: "draft1", title: "Fix login", description: "500", sourceMessageId: "m1" },
      },
    })
    const { getDb } = await import("@/lib/db/schema")
    expect(await getDb().issues.count()).toBe(0)
  })

  it("reports no-projects and pii_blocked without sending", async () => {
    const { deps, sent } = harness()
    expect(
      await proposeIssueFromIm(
        { adapterId: "a", conversationKey: CONV, workspaceId: "w1", title: "x" },
        deps
      )
    ).toEqual({ status: "no-projects" })
    await createIssueProject({ projectId: "w1", name: "M", key: "MERC" })
    const blocked = harness({
      push: {
        enqueue: async () => {},
        buildSegment: () => ({}),
        audit: async (entry) => {
          blockedAudits.push(entry)
        },
        isPiiSafe: () => false,
        now: () => 1,
      },
    })
    const blockedAudits: unknown[] = []
    expect(
      await proposeIssueFromIm(
        { adapterId: "a", conversationKey: CONV, workspaceId: "w1", title: "x" },
        blocked.deps
      )
    ).toEqual({ status: "pii_blocked" })
    expect(blockedAudits[0]).toMatchObject({ kind: "issue.im_pii_blocked" })
    expect(sent).toEqual([])
  })
})
