import type { PluginContext } from "@cognia/plugin-sdk"

import anthropicSkills from "./index"

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

  it("has no deactivate — the manager owns command teardown", () => {
    // The plugin registers nothing imperatively any more, so there is nothing
    // for it to undo. Manifest-declared commands are unregistered by
    // `PluginManager.unregisterPluginSlashCommands`.
    expect(anthropicSkills.deactivate).toBeUndefined()
  })

  it("declares its slash command instead of registering it imperatively", async () => {
    const { ctx } = makeCtx()
    const hooks = await anthropicSkills.activate?.(ctx)
    // The manager owns registration for manifest-declared commands; a plugin
    // touching the registry itself skips namespacing, conflict detection,
    // aliases, the command-palette entry and teardown.
    expect(typeof hooks?.onCommand).toBe("function")
    const commands = (anthropicSkills.manifest as { commands?: Array<{ id: string }> }).commands
    expect(commands?.map((c) => c.id)).toEqual(["skill"])
  })

  it("handles its own command and declines others", async () => {
    const { ctx } = makeCtx()
    const showToast = jest.fn()
    ;(ctx as { ui?: unknown }).ui = { showToast }
    const hooks = await anthropicSkills.activate?.(ctx)
    expect(await hooks?.onCommand?.("not-mine", [])).toBe(false)
    expect(showToast).not.toHaveBeenCalled()
    expect(await hooks?.onCommand?.("skill", [])).toBe(true)
    expect(showToast).toHaveBeenCalled()
  })

  it("declares lazy activation for its command", () => {
    const events = (anthropicSkills.manifest as { activationEvents?: string[] }).activationEvents
    expect(events).toContain("onCommand:skill")
  })
})
