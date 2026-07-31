/**
 * `defineSkill` is a pure identity function whose only job is compile-time
 * type narrowing for plugin authors. The runtime guarantee is "what you put
 * in is what you get out, by reference" — the test below pins that contract
 * so future refactors can't accidentally introduce a clone or default-fill.
 */

import { defineSkill } from "./define-skill"
import type { PluginSkillDef } from "@/types/plugin/plugin-skill"

describe("defineSkill", () => {
  it("returns the same object reference passed in", () => {
    const def: PluginSkillDef = {
      id: "code-review",
      name: "Code Review",
      description: "Reviews code changes",
      source: { kind: "local-folder", path: "./skills/code-review" },
    }

    const result = defineSkill(def)

    expect(result).toBe(def)
  })

  it("preserves every field on the def, including the discriminated `source` union", () => {
    const inline: PluginSkillDef = {
      id: "inline",
      name: "Inline",
      description: "An inline skill",
      source: { kind: "inline", markdown: "# steps" },
    }
    expect(defineSkill(inline).source).toEqual({ kind: "inline", markdown: "# steps" })

    const managed: PluginSkillDef = {
      id: "managed",
      name: "Anthropic Managed",
      description: "Managed skill",
      source: { kind: "anthropic-managed", containerSkillId: "skill-abc" },
    }
    expect(defineSkill(managed).source).toEqual({
      kind: "anthropic-managed",
      containerSkillId: "skill-abc",
    })
  })

  it("narrows the new bundle-shaped variants without losing field shape", () => {
    const bundle: PluginSkillDef = {
      id: "bundle",
      name: "Bundle",
      description: "Folder bundle with sibling resources",
      source: { kind: "local-bundle", path: "./skills/bundle" },
    }
    expect(defineSkill(bundle).source).toEqual({
      kind: "local-bundle",
      path: "./skills/bundle",
    })

    const archive: PluginSkillDef = {
      id: "archive",
      name: "Archive",
      description: "Zipped bundle extracted on enable",
      source: { kind: "archive", path: "./skills/bundle.zip" },
    }
    expect(defineSkill(archive).source).toEqual({
      kind: "archive",
      path: "./skills/bundle.zip",
    })
  })

  it("preserves optional scope and attach lists", () => {
    const def: PluginSkillDef = {
      id: "with-scope",
      name: "Scoped",
      description: "Scoped skill",
      source: { kind: "local-folder", path: "./skill" },
      scope: "team",
      attachToCharacterIds: ["char-1", "char-2"],
      allowedTools: ["bash"],
    }
    expect(defineSkill(def)).toMatchObject({
      scope: "team",
      attachToCharacterIds: ["char-1", "char-2"],
      allowedTools: ["bash"],
    })
  })
})
