import { createDbTestFixture } from "@/lib/db/test-fixture"
import { listPendingInboundDrafts } from "@/lib/db/inbound-drafts"
import { acceptInboundDraft } from "@/lib/db/inbound-drafts"
import { setRetrievalKillSwitch } from "@/lib/db/retrieval-control"
import { submitAgentMemoryFinding } from "./agent-findings"

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(dbFixture.restore)
afterAll(dbFixture.dispose)

describe("agent memory findings", () => {
  it("routes an external agent fact to the private untrusted review queue", async () => {
    await submitAgentMemoryFinding({
      authorId: "external-codex",
      authorKind: "external_agent",
      title: "Package manager",
      body: "The repository uses pnpm.",
      kind: "fact",
      projectId: "project-1",
    })

    expect(await listPendingInboundDrafts()).toEqual([
      expect.objectContaining({
        kind: "lesson",
        status: "pending",
        source: "external-codex",
        body: expect.stringContaining("<untrusted_content>"),
        metadata: expect.objectContaining({
          authorKind: "external_agent",
          trust: "untrusted",
          promotion: "supervisor_or_user_required",
        }),
      }),
    ])
  })

  it("routes procedures and instructions to disabled-skill review materialization", async () => {
    await submitAgentMemoryFinding({
      authorId: "subagent-1",
      authorKind: "subagent",
      title: "Release process",
      body: "Run the release checklist.",
      kind: "instruction",
    })
    expect((await listPendingInboundDrafts())[0]).toMatchObject({
      kind: "skill",
      metadata: expect.objectContaining({ trust: "private", findingKind: "instruction" }),
    })
  })

  it("keeps findings reviewable but blocks promotion while the rollout kill switch is engaged", async () => {
    const outcome = await submitAgentMemoryFinding({
      authorId: "team-member-1",
      authorKind: "team_member",
      title: "Finding",
      body: "A reviewable finding.",
      kind: "fact",
    })
    const draftId = outcome.status === "created" ? outcome.draft.id : outcome.draftId
    await setRetrievalKillSwitch({
      engaged: true,
      changedBy: "safety",
      reasonCode: "rollout_paused",
    })

    await expect(acceptInboundDraft(draftId)).rejects.toThrow("kill switch")
    expect((await listPendingInboundDrafts())[0]).toMatchObject({ id: draftId, status: "pending" })
  })
})
