import type { PluginContext } from "@/types/plugin"

jest.mock("@/lib/slash-commands/registry", () => ({
  registerSlashCommand: jest.fn(),
  unregisterCommandsByPlugin: jest.fn(),
}))

import { registerSlashCommand, unregisterCommandsByPlugin } from "@/lib/slash-commands/registry"
import anthropicSkills from "./index"

const registerMock = registerSlashCommand as jest.Mock
const unregisterMock = unregisterCommandsByPlugin as jest.Mock

function makeCtx() {
  const skills: Array<{ id: string }> = []
  const ctx: Partial<PluginContext> = {
    pluginId: "cognia-anthropic-skills",
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } as never,
    agent: {
      registerSkill: (skill: { id: string }) => {
        skills.push(skill)
      },
    } as never,
  }
  return { ctx: ctx as PluginContext, skills }
}

beforeEach(() => {
  registerMock.mockReset()
  unregisterMock.mockReset()
})

describe("anthropic-skills (built-in)", () => {
  it("activate registers the three starter skills imperatively", async () => {
    const { ctx, skills } = makeCtx()
    await anthropicSkills.activate?.(ctx)
    expect(skills.map((s) => s.id).sort()).toEqual([
      "anthropic.code-review",
      "anthropic.data-analysis",
      "anthropic.web-research",
    ])
  })

  it("declares the same skills on the manifest for the declarative walker", () => {
    const manifest = anthropicSkills.manifest as unknown as { skills: Array<{ id: string }> }
    expect(manifest.skills.map((s) => s.id)).toEqual([
      "anthropic.code-review",
      "anthropic.data-analysis",
      "anthropic.web-research",
    ])
  })

  it("activate registers the /skill slash command", async () => {
    const { ctx } = makeCtx()
    await anthropicSkills.activate?.(ctx)
    expect(registerMock).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "skill.list",
        name: "/skill",
        source: "plugin",
        pluginId: "cognia-anthropic-skills",
      })
    )
  })

  it("deactivate unregisters the plugin's commands", async () => {
    const { ctx } = makeCtx()
    await anthropicSkills.activate?.(ctx)
    await anthropicSkills.deactivate?.(ctx)
    expect(unregisterMock).toHaveBeenCalledWith("cognia-anthropic-skills")
  })

  it("deactivate without a context is a safe no-op", async () => {
    await expect(anthropicSkills.deactivate?.(undefined as never)).resolves.toBeUndefined()
    expect(unregisterMock).not.toHaveBeenCalled()
  })
})
