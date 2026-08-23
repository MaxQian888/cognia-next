import type { KnowledgeBaseSource } from "@/types/knowledge-base"
import { authorizeKnowledgeSource } from "./access"

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
