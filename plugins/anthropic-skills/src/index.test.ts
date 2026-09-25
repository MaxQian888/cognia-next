import type { PluginCommandResult, PluginContext } from "@cognia/plugin-sdk"

import anthropicSkills, { manifest, PLUGIN_ID, renderSkillList, STARTER_SKILLS } from "./index"
import manifestJson from "../plugin.json"

type Locale = keyof typeof manifestJson.i18n.locales

/** `ctx.i18n.t` over the plugin's own bundle — same `{name}` interpolation as the host. */
function translator(locale: Locale) {
  const bundle = manifestJson.i18n.locales[locale] as Record<string, string>
  return (key: string, params?: Record<string, string | number>) => {
    const value = bundle[key]
    if (value === undefined) throw new Error(`missing ${locale} key ${key}`)
    return value.replace(/\{(\w+)\}/g, (match, name: string) =>
      params?.[name] !== undefined ? String(params[name]) : match
    )
  }
}

function makeCtx(locale: Locale = "en") {
  const registerSkill = jest.fn()
  const showToast = jest.fn()
  const ctx = {
    pluginId: PLUGIN_ID,
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    agent: { registerSkill },
    ui: { showToast },
    i18n: { t: translator(locale) },
  } as unknown as PluginContext
  return { ctx, registerSkill, showToast }
}

describe("anthropic-skills (Starter Skills)", () => {
  it("declares three namespaced skills on the manifest for the declarative walker", () => {
    expect(manifest.skills?.map((s) => s.id)).toEqual([
      `${PLUGIN_ID}:code-review`,
      `${PLUGIN_ID}:data-analysis`,
      `${PLUGIN_ID}:web-research`,
    ])
    for (const skill of manifest.skills ?? []) {
      expect(skill.source.kind).toBe("inline")
      expect(skill.slug).toBe(skill.id.slice(`${PLUGIN_ID}:`.length))
    }
  })

  it("does not register the manifest skills a second time imperatively", async () => {
    const { ctx, registerSkill } = makeCtx()
    await anthropicSkills.activate?.(ctx)
    expect(registerSkill).not.toHaveBeenCalled()
  })

  it("describes the skills truthfully (hand-written, not vendored)", () => {
    expect(manifestJson.description).not.toMatch(/anthropics\/skills/i)
    expect(manifestJson.description).toMatch(/hand-written/)
  })

  it("activates lazily on its command, never at startup", () => {
    expect(manifest.activationEvents).toEqual(["onCommand:skill"])
  })

  it("keeps plugin.json fields when merging the TypeScript skills", () => {
    expect(manifest.commands?.map((c) => c.id)).toEqual(["skill"])
    expect(manifest.i18n).toEqual(manifestJson.i18n)
  })

  it("answers /skill in the conversation with the localized list and composer how-to", async () => {
    const { ctx, showToast } = makeCtx("en")
    const hooks = (await anthropicSkills.activate?.(ctx)) as {
      onCommand: (command: string, args: string[]) => Promise<boolean | PluginCommandResult>
    }
    expect(await hooks.onCommand("not-mine", [])).toBe(false)
    const result = (await hooks.onCommand("skill", [])) as PluginCommandResult
    expect(result.handled).toBe(true)
    expect(result.message).toContain("Code Review")
    expect(result.message).toContain("`@skill:`")
    // The old toast sent users to character settings, which never listed these.
    expect(result.message).not.toMatch(/character/i)
    expect(showToast).not.toHaveBeenCalled()
  })

  it("renders the zh-CN list from the same keys", () => {
    const message = renderSkillList(translator("zh-CN"))
    expect(message).toContain("代码审查")
    expect(message).toContain("`@skill:`")
  })

  it("has a matching zh-CN key for every en key", () => {
    expect(Object.keys(manifestJson.i18n.locales["zh-CN"]).sort()).toEqual(
      Object.keys(manifestJson.i18n.locales.en).sort()
    )
    expect(STARTER_SKILLS).toHaveLength(3)
  })

  it("has no deactivate — the manager owns command and skill teardown", () => {
    expect(anthropicSkills.deactivate).toBeUndefined()
  })
})
