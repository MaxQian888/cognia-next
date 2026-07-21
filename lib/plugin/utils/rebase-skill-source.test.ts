import { escapesBaseDir, isAnchoredPath, rebaseSkillSource } from "./rebase-skill-source"
import type { PluginSkillDef, PluginSkillSource } from "@/types/plugin/plugin-skill"

function makeDef(source: PluginSkillSource): PluginSkillDef {
  return { id: "s1", name: "Skill One", description: "d", source }
}

describe("isAnchoredPath", () => {
  it.each(["/abs/path", "\\\\server\\share", "C:/win", "c:\\win", "builtin://x", "asset://y"])(
    "treats %s as anchored",
    (path) => {
      expect(isAnchoredPath(path)).toBe(true)
    }
  )

  it.each(["skills/foo", "./skills/foo", "foo.zip", "a/b/c"])("treats %s as relative", (path) => {
    expect(isAnchoredPath(path)).toBe(false)
  })
})

describe("escapesBaseDir", () => {
  it("accepts paths that stay inside", () => {
    expect(escapesBaseDir("skills/foo")).toBe(false)
    expect(escapesBaseDir("./skills/./foo")).toBe(false)
    expect(escapesBaseDir("a/b/../c")).toBe(false)
  })

  it("rejects paths that climb out", () => {
    expect(escapesBaseDir("../foo")).toBe(true)
    expect(escapesBaseDir("a/../../foo")).toBe(true)
    expect(escapesBaseDir("..\\foo")).toBe(true)
  })

  it("rejects a path that climbs out and comes back", () => {
    // `a/../../b/c` nets to `../b/c` — still an escape even though the
    // final depth is positive.
    expect(escapesBaseDir("a/../../b/c")).toBe(true)
  })
})

describe("rebaseSkillSource", () => {
  const root = "/Users/me/plugins/my-plugin"

  it("leaves inline sources untouched", () => {
    const def = makeDef({ kind: "inline", markdown: "# hi" })
    expect(rebaseSkillSource(def, root)).toBe(def)
  })

  it("leaves anthropic-managed sources untouched", () => {
    const def = makeDef({ kind: "anthropic-managed", containerSkillId: "abc" })
    expect(rebaseSkillSource(def, root)).toBe(def)
  })

  it.each(["local-folder", "local-bundle"] as const)("rebases a relative %s path", (kind) => {
    const def = makeDef({ kind, path: "skills/researcher" })
    const out = rebaseSkillSource(def, root)
    expect(out.source).toEqual({ kind, path: `${root}/skills/researcher` })
  })

  it("rebases a relative archive path", () => {
    const def = makeDef({ kind: "archive", path: "bundles/pack.zip" })
    expect(rebaseSkillSource(def, root).source).toEqual({
      kind: "archive",
      path: `${root}/bundles/pack.zip`,
    })
  })

  it("normalises separators and duplicate slashes when joining", () => {
    const def = makeDef({ kind: "local-folder", path: "/skills/a" })
    // A leading slash makes the path anchored, so it is NOT rebased.
    expect(rebaseSkillSource(def, root)).toBe(def)

    const trailing = makeDef({ kind: "local-folder", path: "skills/a" })
    expect(rebaseSkillSource(trailing, `${root}/`).source).toEqual({
      kind: "local-folder",
      path: `${root}/skills/a`,
    })
  })

  it("leaves absolute paths untouched", () => {
    const def = makeDef({ kind: "local-folder", path: "/opt/shared/skill" })
    expect(rebaseSkillSource(def, root)).toBe(def)
  })

  it("leaves the def untouched when there is no install root", () => {
    const def = makeDef({ kind: "local-folder", path: "skills/a" })
    expect(rebaseSkillSource(def, "")).toBe(def)
  })

  it("does not mutate the input def", () => {
    const def = makeDef({ kind: "local-folder", path: "skills/a" })
    rebaseSkillSource(def, root)
    expect(def.source).toEqual({ kind: "local-folder", path: "skills/a" })
  })

  it("throws when a relative path escapes the plugin directory", () => {
    const def = makeDef({ kind: "local-folder", path: "../../../etc" })
    expect(() => rebaseSkillSource(def, root)).toThrow(/escapes the plugin directory/)
  })
})
