/**
 * Registration smoke for the platform-neutral `im.*` family — mirror of
 * `lark/families.test.ts`, scoped to `im.*` rows because the shared registry
 * may also hold the lark families depending on import order.
 */
import { getSharedBuiltInSkillRegistry } from "../registry"
import "./index"

function imSkills() {
  return getSharedBuiltInSkillRegistry()
    .list()
    .filter((s) => s.family === "im")
}

describe("im.* skill family — registration smoke", () => {
  it("registers exactly the documented seven skills", () => {
    expect(
      imSkills()
        .map((s) => s.id)
        .sort()
    ).toEqual([
      "im.broadcast",
      "im.create_chat",
      "im.dispatch_task",
      "im.invite_members",
      "im.remove_members",
      "im.resolve_contact",
      "im.update_chat",
    ])
  })

  it("every im.* skill is platform-neutral (platforms === 'any')", () => {
    for (const skill of imSkills()) {
      expect(skill.platforms).toBe("any")
    }
  })

  it("capability requires match the design table", () => {
    const byId = Object.fromEntries(imSkills().map((s) => [s.id, s]))
    expect(byId["im.create_chat"].requires).toEqual(["chat.create"])
    expect(byId["im.invite_members"].requires).toEqual(["chat.members"])
    expect(byId["im.remove_members"].requires).toEqual(["chat.members"])
    expect(byId["im.update_chat"].requires).toEqual(["chat.update"])
    expect(byId["im.resolve_contact"].requires).toEqual(["contact.resolve"])
    expect(byId["im.broadcast"].requires ?? []).toEqual([])
    // No `requires`: the existing-conversation path needs no chat-management
    // capability; the create path checks `chat.create` at execute time.
    expect(byId["im.dispatch_task"].requires ?? []).toEqual([])
  })

  it("mutation / imAccess tiers match the design table", () => {
    const byId = Object.fromEntries(imSkills().map((s) => [s.id, s]))
    expect(byId["im.create_chat"]).toMatchObject({ mutation: "write", imAccess: "always" })
    expect(byId["im.invite_members"]).toMatchObject({ mutation: "write", imAccess: "always" })
    expect(byId["im.remove_members"]).toMatchObject({
      mutation: "destructive",
      imAccess: "opt-in",
    })
    expect(byId["im.update_chat"]).toMatchObject({ mutation: "write", imAccess: "always" })
    expect(byId["im.resolve_contact"]).toMatchObject({ mutation: "read", imAccess: "always" })
    expect(byId["im.broadcast"]).toMatchObject({ mutation: "write", imAccess: "opt-in" })
    expect(byId["im.dispatch_task"]).toMatchObject({ mutation: "write", imAccess: "opt-in" })
  })

  it("every non-read im.* skill ships a hitlSurface with confirm/cancel buttons", () => {
    for (const skill of imSkills().filter((s) => s.mutation !== "read")) {
      expect(skill.hitlSurface).toBeDefined()
      const surface = skill.hitlSurface!(sampleArgsFor(skill.id))
      const components = surface.components as Record<string, unknown>
      expect(components.btn_confirm).toBeDefined()
      expect(components.btn_cancel).toBeDefined()
    }
  })

  it("mcpToolName follows the family_suffix convention", () => {
    for (const skill of imSkills()) {
      expect(skill.mcpToolName).toBe(skill.id.replace(/\./g, "_"))
    }
  })
})

function sampleArgsFor(id: string): never {
  const args: Record<string, unknown> = {
    "im.create_chat": { name: "G", memberIds: ["ou_a"], firstMessage: "hi" },
    "im.invite_members": { memberIds: ["ou_a"], chatId: "oc_1" },
    "im.remove_members": { memberIds: ["ou_a"], chatId: "oc_1" },
    "im.update_chat": { chatId: "oc_1", name: "N" },
    "im.broadcast": { conversationKeys: ["lark:a1:oc_1"], message: "hello" },
    "im.dispatch_task": {
      title: "Ship W4",
      brief: "Implement the dispatch skill",
      respondWithTeamId: "team_1",
      memberIds: ["ou_a"],
    },
  }
  return args[id] as never
}
