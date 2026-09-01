import {
  platformIdForSquadTemplate,
  publishSquadTemplateToPlatform,
} from "./publish-template-to-platform"
import type { AgentTeamTemplate } from "@/types/agent/agent-team"

function template(over: Partial<AgentTeamTemplate> = {}): AgentTeamTemplate {
  return {
    id: "tpl_a",
    name: "Review squad",
    description: "reviews things",
    category: "review",
    teammates: [{ name: "Reviewer", description: "reviews" }],
    config: {},
    ...over,
  } as AgentTeamTemplate
}

function harness(existingDraft?: { revision: number }) {
  const createDraft = jest.fn(async () => ({}))
  const saveDraft = jest.fn(async () => ({}))
  return {
    createDraft,
    saveDraft,
    runtime: {
      repository: { getDraft: async () => existingDraft },
      service: { createDraft, saveDraft },
    } as never,
  }
}

describe("publishSquadTemplateToPlatform", () => {
  /**
   * The gap this closes: the projection ran only at boot, so a template you had
   * just saved was absent from Discover, global search, fork and export until
   * the next restart.
   */
  it("creates a platform draft for a new template", async () => {
    const h = harness()
    await publishSquadTemplateToPlatform(template(), h.runtime)
    expect(h.createDraft).toHaveBeenCalledWith(
      expect.objectContaining({ id: "legacy.agentTeam.tpl_a", domain: "agentTeam" })
    )
  })

  /** A stable id is what makes re-saving an update rather than a duplicate. */
  it("updates the existing draft instead of minting a second one", async () => {
    const h = harness({ revision: 3 })
    await publishSquadTemplateToPlatform(template({ name: "Renamed" }), h.runtime)
    expect(h.createDraft).not.toHaveBeenCalled()
    expect(h.saveDraft).toHaveBeenCalledWith(
      expect.objectContaining({ id: "legacy.agentTeam.tpl_a" }),
      3
    )
  })

  it("leaves built-ins alone, since the boot overlay already projects them", async () => {
    const h = harness()
    await publishSquadTemplateToPlatform(template({ isBuiltIn: true }), h.runtime)
    expect(h.createDraft).not.toHaveBeenCalled()
    expect(h.saveDraft).not.toHaveBeenCalled()
  })

  /** The store still holds the template, so a mirror failure must not surface. */
  it("swallows a platform failure rather than losing the save", async () => {
    const runtime = {
      repository: {
        getDraft: async () => {
          throw new Error("db closed")
        },
      },
      service: {},
    } as never
    await expect(publishSquadTemplateToPlatform(template(), runtime)).resolves.toBeUndefined()
  })

  it("derives a stable id from the template id", () => {
    expect(platformIdForSquadTemplate(template())).toBe("legacy.agentTeam.tpl_a")
  })
})
