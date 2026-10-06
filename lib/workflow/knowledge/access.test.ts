import type { KnowledgeBaseSource } from "@/types/knowledge-base"
import { authorizeKnowledgeSource, resolveWorkflowKnowledgeAccess } from "./access"
const getWorkflowRun = jest.fn()
jest.mock("@/lib/db/schema", () => ({
  getDb: () => ({ workflowRuns: { get: (...args: unknown[]) => getWorkflowRun(...args) } }),
}))

describe("resolveWorkflowKnowledgeAccess", () => {
  it("does not manufacture public or local authority from an unbound workflow", async () => {
    await expect(resolveWorkflowKnowledgeAccess({ runId: "unbound" })).resolves.toBeUndefined()
  })
  it("uses the durable principal and narrows scope to immutable admitted revisions", async () => {
    const triggeredBy = {
      source: "api" as const,
      initiator: { authenticated: true, principalId: "verified" },
    }
    getWorkflowRun.mockResolvedValue({ triggeredBy })
    await expect(
      resolveWorkflowKnowledgeAccess({
        runId: "public",
        executionBinding: {
          entrypoint: "http",
          dependencyLock: {
            workflows: {},
            indexes: {
              "knowledge:kb:s1": "g1",
              "knowledge:kb:s2": "g2",
              "knowledge:kb:duplicate": "g1",
              "other:index": "unrelated",
            },
          },
        } as never,
      })
    ).resolves.toEqual({
      entrypoint: "http",
      triggeredBy,
      revisionBindings: { kb: ["g1", "g2"] },
      allowedKnowledgeBaseIds: ["kb"],
    })
    expect(getWorkflowRun).toHaveBeenCalledWith("public")
  })
  it("gives admitted workflows without index bindings an empty knowledge ceiling", async () => {
    getWorkflowRun.mockResolvedValue(undefined)
    await expect(
      resolveWorkflowKnowledgeAccess({
        runId: "missing-principal",
        executionBinding: { entrypoint: "mcp" } as never,
      })
    ).resolves.toEqual({
      entrypoint: "mcp",
      triggeredBy: undefined,
      revisionBindings: {},
      allowedKnowledgeBaseIds: [],
    })
  })
})

const source = (acl?: KnowledgeBaseSource["acl"]): KnowledgeBaseSource =>
  ({ id: "src", acl }) as KnowledgeBaseSource

describe("authorizeKnowledgeSource", () => {
  it("keeps legacy private sources available to trusted local execution", () => {
    expect(authorizeKnowledgeSource({ source: source(), entrypoint: "desktop" })).toMatchObject({
      allowed: true,
      reason: "trusted-local",
    })
  })

  it("allows anonymous public sources and denies ACL-less sources", () => {
    expect(
      authorizeKnowledgeSource({
        source: source({ visibility: "public" }),
        entrypoint: "portal",
      }).allowed
    ).toBe(true)
    expect(authorizeKnowledgeSource({ source: source(), entrypoint: "portal" }).allowed).toBe(false)
  })

  it("accepts only verified principal and group ACL matches", () => {
    const triggeredBy = {
      source: "api" as const,
      initiator: {
        authenticated: true,
        principalId: "member-1",
        groupIds: ["reviewers"],
        externalSubjectKey: "dify-user-cannot-authorize",
      },
    }
    expect(
      authorizeKnowledgeSource({
        source: source({ visibility: "private", principalIds: ["member-1"] }),
        entrypoint: "http",
        triggeredBy,
      }).reason
    ).toBe("principal")
    expect(
      authorizeKnowledgeSource({
        source: source({ visibility: "restricted", groupIds: ["reviewers"] }),
        entrypoint: "mcp",
        triggeredBy,
      }).reason
    ).toBe("group")
    expect(
      authorizeKnowledgeSource({
        source: source({ visibility: "private", groupIds: ["reviewers"] }),
        entrypoint: "http",
        triggeredBy,
      }).allowed
    ).toBe(false)
  })
})
